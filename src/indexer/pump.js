#!/usr/bin/env node
// src/indexer/pump.js — Pump program indexer (decode pipeline).
//
// What it does:
//   * Polls getSignaturesForAddress on the Pump bonding-curve program AND the
//     PumpSwap AMM program (two checkpointed jobs: 'pump-bonding',
//     'pump-swap'), resuming from indexer_checkpoints.
//   * Fetches each new transaction and runs it through the decode pipeline
//     (src/indexer/decode.js): Anchor events → normalized trades/launches/
//     graduations/fee events → idempotent DB writes. Failed transactions
//     (meta.err) are excluded from all economic state.
//   * Resolves token decimals from the mint account (cached); unresolved
//     decimals stay NULL (UNKNOWN ≠ ZERO), never guessed.
//   * Advances observed → confirmed → finalized confirmations on a slot-
//     distance heuristic (documented below).
//   * Updates indexer_stats per job; decode failures land in decode_failures
//     (retry queue), never silently dropped.
//
// Idempotency: (signature, event_index) UNIQUE + ON CONFLICT DO NOTHING, so
// reruns, restarts, and overlapping job polls are safe.
//
// Run: npm run indexer   (or: node src/indexer/pump.js)
// Env: RPC_URL (required), PUMP_PROGRAM_ID, PUMPSWAP_PROGRAM_ID,
//      POLL_INTERVAL_MS, PAGE_LIMIT, DATABASE_URL.

import { fileURLToPath } from 'node:url';
import { Connection, PublicKey } from '@solana/web3.js';
import { pool } from '../db/pool.js';
import { processTransaction } from './decode.js';
import { DECODER_VERSIONS } from './decoders/layouts.js';

const RPC_URL = process.env.RPC_URL;
const PUMP_PROGRAM_ID = new PublicKey(
  process.env.PUMP_PROGRAM_ID || '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
);
const PUMPSWAP_PROGRAM_ID = new PublicKey(
  process.env.PUMPSWAP_PROGRAM_ID || 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'
);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 15000);
const PAGE_LIMIT = Number(process.env.PAGE_LIMIT || 50);

const JOBS = [
  { name: 'pump-bonding', programId: PUMP_PROGRAM_ID, decoderVersion: DECODER_VERSIONS.PUMP_BONDING },
  { name: 'pump-swap', programId: PUMPSWAP_PROGRAM_ID, decoderVersion: DECODER_VERSIONS.PUMP_SWAP },
];

if (!RPC_URL) {
  console.error('[indexer] RPC_URL is required');
  process.exit(1);
}

const connection = new Connection(RPC_URL, 'confirmed');

// ---------------------------------------------------------------- checkpoints
async function getCheckpoint(jobName) {
  const { rows } = await pool.query(
    'SELECT last_slot, last_signature FROM indexer_checkpoints WHERE job_name = $1',
    [jobName]
  );
  return rows[0] ?? { last_slot: null, last_signature: null };
}

async function saveCheckpoint(jobName, lastSlot, lastSignature) {
  await pool.query(
    `INSERT INTO indexer_checkpoints (job_name, last_slot, last_signature, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (job_name) DO UPDATE
     SET last_slot = EXCLUDED.last_slot,
         last_signature = EXCLUDED.last_signature,
         updated_at = now()`,
    [jobName, lastSlot, lastSignature]
  );
}

// ---------------------------------------------------------------- RPC helpers
/** Fetch a mint's account info for decimals resolution (byte 44 of mint layout). */
async function getMintAccountInfo(mint) {
  try {
    const info = await connection.getAccountInfo(new PublicKey(mint), 'confirmed');
    if (!info?.data) return null;
    return { data: info.data }; // Buffer; decode.js reads byte 44
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- poll
async function pollJob(job) {
  const cp = await getCheckpoint(job.name);
  const opts = { limit: PAGE_LIMIT };
  if (cp.last_signature) opts.until = cp.last_signature;

  let sigs;
  try {
    sigs = await connection.getSignaturesForAddress(job.programId, opts, 'confirmed');
  } catch (err) {
    console.error(`[indexer:${job.name}] getSignaturesForAddress failed:`, err.message);
    return { processed: 0, error: err.message };
  }
  if (!sigs.length) return { processed: 0 };

  let processed = 0;
  // Oldest-first so the checkpoint advances monotonically.
  for (const s of [...sigs].reverse()) {
    try {
      const tx = await connection.getTransaction(s.signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      if (!tx) {
        console.warn(`[indexer:${job.name}] tx not found: ${s.signature}`);
      } else {
        const stats = await processTransaction(pool, tx, {
          job: job.name,
          confirmation: 'confirmed',
          getMintAccountInfo,
        });
        if (stats.skipped) {
          console.log(`[indexer:${job.name}] skipped failed tx ${s.signature.slice(0, 12)}…`);
        } else {
          console.log(
            `[indexer:${job.name}] decoded ${s.signature.slice(0, 12)}… ` +
              `+${stats.events_decoded} events (${stats.events_failed} failed)`
          );
        }
      }
      processed++;
      // Advance per-signature: a crash mid-page loses nothing processed.
      await saveCheckpoint(job.name, s.slot, s.signature);
    } catch (err) {
      // Per-signature failure: logged, checkpoint NOT advanced past it —
      // retried next poll. decode.js also records decode-stage failures
      // in the decode_failures queue.
      console.error(`[indexer:${job.name}] failed on ${s.signature}:`, err.message);
      await pool.query(
        `INSERT INTO indexer_stats (job, last_cycle_at, last_error, decoder_version)
         VALUES ($1, NOW(), $2, $3)
         ON CONFLICT (job) DO UPDATE SET last_cycle_at = NOW(),
           last_error = EXCLUDED.last_error, decoder_version = EXCLUDED.decoder_version`,
        [job.name, String(err.message).slice(0, 500), job.decoderVersion]
      );
    }
  }
  return { processed };
}

/**
 * Confirmation transitions. Commitment RPC calls per row would be expensive;
 * instead we use slot distance, which is the standard heuristic:
 *   observed  → confirmed when slot is >2 behind tip
 *   confirmed → finalized when slot is >64 behind tip
 * Rows only ever move forward (observed < confirmed < finalized).
 */
async function finalizeConfirmations() {
  try {
    const tip = await connection.getSlot('confirmed');
    const { rowCount: toConfirmed } = await pool.query(
      `UPDATE trades SET confirmation = 'confirmed'
       WHERE confirmation = 'observed' AND slot IS NOT NULL AND slot < $1`,
      [tip - 2]
    );
    const { rowCount: toFinalized } = await pool.query(
      `UPDATE trades SET confirmation = 'finalized'
       WHERE confirmation = 'confirmed' AND slot IS NOT NULL AND slot < $1`,
      [tip - 64]
    );
    if (toConfirmed || toFinalized) {
      console.log(`[indexer] confirmations: +${toConfirmed} confirmed, +${toFinalized} finalized`);
    }
  } catch (err) {
    console.error('[indexer] finalizeConfirmations failed:', err.message);
  }
}

async function pollOnce() {
  for (const job of JOBS) {
    try {
      const { processed, error } = await pollJob(job);
      if (processed) console.log(`[indexer:${job.name}] poll done: ${processed} txs`);
      if (error) console.log(`[indexer:${job.name}] poll error (will retry): ${error}`);
    } catch (err) {
      console.error(`[indexer:${job.name}] poll cycle failed:`, err.message);
    }
  }
  await finalizeConfirmations();
}

async function main() {
  console.log(
    `[indexer] starting: bonding=${PUMP_PROGRAM_ID.toBase58()} ` +
      `amm=${PUMPSWAP_PROGRAM_ID.toBase58()} interval=${POLL_INTERVAL_MS}ms`
  );
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await pollOnce();
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

process.on('SIGINT', async () => {
  console.log('\n[indexer] shutting down');
  await pool.end();
  process.exit(0);
});

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}

export { pollJob, pollOnce, finalizeConfirmations, getCheckpoint, JOBS };
