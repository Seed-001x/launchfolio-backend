#!/usr/bin/env node
// src/indexer/watch.js — Watchlist indexer entrypoint (lean launch).
//
// Polls getSignaturesForAddress per watched mint. The watchlist lives in the
// watched_mints DB table (active=true) — the SOLE authority. Launches
// through the pad insert here, so new coins are picked up with no redeploy
// and no env-var edit. The table is re-read every REFRESH_INTERVAL_MS
// (default 5 min), so newly registered mints join automatically.
//
// (The legacy WATCHLIST_MINTS env var is intentionally ignored: it belonged
// to the Crankpad project and kept re-indexing CRANK after the purge.)
//
// Pump trade transactions always reference the mint, so per-mint polling
// catches them. Reuses pump.js's decode pipeline (processTransaction via
// pollJob): Anchor events → normalized trades → idempotent DB writes.
//
// Env: RPC_URL (required), DATABASE_URL (required),
//      POLL_INTERVAL_MS (default 60000), REFRESH_INTERVAL_MS (default 300000),
//      PAGE_LIMIT.

import { PublicKey } from '@solana/web3.js';
import { pollJob, finalizeConfirmations } from './pump.js';
import { DECODER_VERSIONS } from './decoders/layouts.js';
import { pool } from '../db/pool.js';
import { settleOnce } from './settle.js';

const INTERVAL = Number(process.env.POLL_INTERVAL_MS || 60000);
const REFRESH_INTERVAL = Number(process.env.REFRESH_INTERVAL_MS || 300000);

if (!process.env.RPC_URL) {
  console.error('[watch] RPC_URL is required');
  process.exit(1);
}

async function dbMints() {
  try {
    const { rows } = await pool.query(
      'SELECT mint FROM watched_mints WHERE active ORDER BY added_at'
    );
    return rows.map((r) => r.mint);
  } catch (e) {
    console.error('[watch] watched_mints read failed:', e.message);
    return [];
  }
}

function makeJob(mint) {
  return {
    name: `watch:${mint}`,
    programId: new PublicKey(mint),
    decoderVersion: DECODER_VERSIONS.PUMP_BONDING, // bookkeeping; decode.js resolves per instruction
  };
}

let jobs = [];
let lastRefresh = 0;

async function refreshJobs(force = false) {
  const now = Date.now();
  if (!force && now - lastRefresh < REFRESH_INTERVAL) return;
  lastRefresh = now;
  const seen = new Set();
  const mints = [];
  for (const m of await dbMints()) {
    if (!seen.has(m)) {
      seen.add(m);
      mints.push(m);
    }
  }
  const next = mints.map(makeJob);
  const added = next.filter((j) => !jobs.some((k) => k.name === j.name));
  const removed = jobs.filter((j) => !next.some((k) => k.name === j.name));
  for (const j of added) console.log(`[watch] now watching ${j.name}`);
  for (const j of removed) console.log(`[watch] stopped watching ${j.name}`);
  jobs = next;
}

async function main() {
  await refreshJobs(true);
  console.log(`[watch] watching ${jobs.length} mint(s), interval=${INTERVAL}ms`);
  for (;;) {
    await refreshJobs();
    if (!jobs.length) {
      console.log('[watch] watchlist empty — waiting for launches to register mints');
    }
    for (const job of jobs) {
      try {
        const r = await pollJob(job);
        if (r.processed) console.log(`[watch] ${job.name}: +${r.processed} txs`);
        if (r.error) console.log(`[watch] ${job.name}: ${r.error} (retry)`);
      } catch (e) {
        console.error(`[watch] ${job.name} failed:`, e.message);
      }
    }
    try {
      await finalizeConfirmations();
    } catch (e) {
      console.error('[watch] finalizeConfirmations failed:', e.message);
    }
    // Settlement: rebuild positions → mint cards → award XP for new trades.
    try {
      await settleOnce(pool);
    } catch (e) {
      console.error('[watch] settle failed:', e.message);
    }
    await new Promise((r) => setTimeout(r, INTERVAL));
  }
}

main();
