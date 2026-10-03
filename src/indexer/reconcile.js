#!/usr/bin/env node
// src/indexer/reconcile.js — verify indexed data against on-chain truth.
//
// For a slot range (or a single signature), re-decodes every Pump transaction
// with the pure decoders and compares against the database:
//   * every decoded trade/launch/graduation has a matching row
//   * stored raw amounts match the decoded raw amounts exactly
//   * decoder_version matches the current decoder
//   * decode failures are reported (they live in the retry queue)
//   * STEP 12: decoded trade amounts are reconciled against the transaction's
//     on-chain balance movements (balance-mismatch entries)
//
// Discrepancies are REPORTED, never auto-fixed — an operator decides whether
// to re-run the backfill. Exit 0 when clean, 1 when discrepancies exist.
//
// Usage:
//   npm run reconcile -- --from-slot 300000000 --to-slot 300001000
//   npm run reconcile -- --signature <base58>
//   Options: --program pump|pumpswap (default: both), --max-txs N (default 200)
//
// Env: RPC_URL (required), DATABASE_URL (required).

import { fileURLToPath } from 'node:url';
import { Connection, PublicKey } from '@solana/web3.js';
import { pool } from '../db/pool.js';
import { decodePumpBondingTransaction } from './decoders/pumpBonding.js';
import { decodePumpSwapTransaction } from './decoders/pumpSwap.js';
import { reconcileTradeAmounts } from './reconcileTrade.js';
import { PROGRAM_IDS, DECODER_VERSIONS } from './decoders/layouts.js';

const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) {
  console.error('[reconcile] RPC_URL is required');
  process.exit(1);
}
const connection = new Connection(RPC_URL, 'confirmed');

function parseArgs(argv) {
  const out = { program: 'both', maxTxs: 200 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from-slot') out.fromSlot = Number(argv[++i]);
    else if (a === '--to-slot') out.toSlot = Number(argv[++i]);
    else if (a === '--signature') out.signature = argv[++i];
    else if (a === '--program') out.program = argv[++i];
    else if (a === '--max-txs') out.maxTxs = Number(argv[++i]);
  }
  return out;
}

const PROGRAMS =
  {
    pump: [{ name: 'pump-bonding', id: new PublicKey(PROGRAM_IDS.PUMP) }],
    pumpswap: [{ name: 'pump-swap', id: new PublicKey(PROGRAM_IDS.PUMP_AMM) }],
    both: [
      { name: 'pump-bonding', id: new PublicKey(PROGRAM_IDS.PUMP) },
      { name: 'pump-swap', id: new PublicKey(PROGRAM_IDS.PUMP_AMM) },
    ],
  };

async function collectSignatures(programId, { fromSlot, toSlot, maxTxs }) {
  const sigs = [];
  let before;
  while (sigs.length < maxTxs) {
    const page = await connection.getSignaturesForAddress(
      programId,
      { limit: Math.min(100, maxTxs - sigs.length), before },
      'confirmed'
    );
    if (!page.length) break;
    for (const s of page) {
      if (toSlot != null && s.slot > toSlot) continue;
      if (fromSlot != null && s.slot < fromSlot) {
        return sigs; // pages are newest-first; older pages only get older
      }
      if (!s.err) sigs.push(s);
    }
    before = page[page.length - 1].signature;
  }
  return sigs;
}

async function resolvePoolFromDb(poolAddr) {
  const { rows } = await pool.query(
    'SELECT base_mint, quote_mint, base_decimals, quote_decimals FROM amm_pools WHERE pool = $1',
    [poolAddr]
  );
  return rows[0] || null;
}

async function reconcileTx(signature, report) {
  const tx = await connection.getTransaction(signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });
  if (!tx) {
    report.push({ signature, kind: 'tx-not-found' });
    return;
  }
  if (tx.meta?.err) {
    // Failed txs must have NO economic rows.
    const { rows } = await pool.query('SELECT 1 FROM trades WHERE signature = $1 LIMIT 1', [
      signature,
    ]);
    if (rows.length) report.push({ signature, kind: 'failed-tx-has-rows' });
    return;
  }

  const bonding = decodePumpBondingTransaction(tx, {});
  const swap = decodePumpSwapTransaction(tx, { resolvePool: resolvePoolFromDb });

  for (const f of [...bonding.failures, ...swap.failures]) {
    report.push({ signature, kind: 'decode-failure', detail: `${f.stage}: ${f.error}` });
  }

  const trades = [...bonding.trades, ...swap.trades];
  for (const t of trades) {
    const { rows } = await pool.query(
      `SELECT token_amount_raw, pair_amount_raw, decoder_version, side, mint
       FROM trades WHERE signature = $1 AND event_index = $2`,
      [signature, t.event_index]
    );
    if (!rows.length) {
      report.push({ signature, kind: 'missing-trade', detail: `event_index ${t.event_index}` });
      continue;
    }
    const row = rows[0];
    const checks = [
      ['token_amount_raw', row.token_amount_raw, t.token_amount_raw.toString()],
      ['pair_amount_raw', row.pair_amount_raw, t.pair_amount_raw.toString()],
      ['side', row.side, t.side],
      ['mint', row.mint, t.mint],
    ];
    for (const [field, stored, decoded] of checks) {
      if (String(stored) !== String(decoded)) {
        report.push({
          signature,
          kind: 'amount-mismatch',
          detail: `event ${t.event_index} ${field}: db=${stored} chain=${decoded}`,
        });
      }
    }
    const expectedVersion =
      t.decoder_version === DECODER_VERSIONS.PUMP_SWAP
        ? DECODER_VERSIONS.PUMP_SWAP
        : DECODER_VERSIONS.PUMP_BONDING;
    if (row.decoder_version !== expectedVersion) {
      report.push({
        signature,
        kind: 'decoder-version-mismatch',
        detail: `event ${t.event_index}: db=${row.decoder_version} expected=${expectedVersion}`,
      });
    }
  }

  // STEP 12: balance reconciliation — decoded amounts vs the transaction's
  // actual on-chain movements. Runs on the live tx regardless of DB state;
  // the decode pipeline queues these as 'reconcile:trade' failures too, so
  // this doubles as an independent audit of that tripwire.
  for (const t of trades) {
    const rec = reconcileTradeAmounts(t, tx);
    if (rec.mismatch) {
      report.push({
        signature,
        kind: 'balance-mismatch',
        detail: `event ${t.event_index}: ${rec.summary}`,
      });
    }
  }

  for (const l of bonding.launches) {
    const { rows } = await pool.query('SELECT 1 FROM tokens WHERE mint = $1', [l.mint]);
    if (!rows.length) report.push({ signature, kind: 'missing-token', detail: l.mint });
  }
  for (const g of bonding.graduations) {
    const { rows } = await pool.query('SELECT launch_state FROM tokens WHERE mint = $1', [g.mint]);
    if (!rows.length || rows[0].launch_state !== 'graduated') {
      report.push({ signature, kind: 'graduation-not-applied', detail: g.mint });
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const programs = PROGRAMS[args.program] || PROGRAMS.both;
  const report = [];

  try {
    if (args.signature) {
      await reconcileTx(args.signature, report);
    } else {
      if (args.fromSlot == null || args.toSlot == null) {
        console.error('[reconcile] need --from-slot and --to-slot, or --signature');
        process.exit(2);
      }
      for (const p of programs) {
        const sigs = await collectSignatures(p.id, args);
        console.log(`[reconcile] ${p.name}: ${sigs.length} txs in range`);
        for (const s of sigs) {
          try {
            await reconcileTx(s.signature, report);
          } catch (err) {
            report.push({ signature: s.signature, kind: 'reconcile-error', detail: err.message });
          }
        }
      }
    }

    console.log(`\n[reconcile] ${report.length} discrepanc${report.length === 1 ? 'y' : 'ies'}`);
    for (const r of report.slice(0, 50)) {
      console.log(`  - ${r.signature.slice(0, 16)}… ${r.kind}${r.detail ? ` — ${r.detail}` : ''}`);
    }
    if (report.length > 50) console.log(`  … and ${report.length - 50} more`);
    process.exitCode = report.length ? 1 : 0;
  } finally {
    await pool.end();
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error('[reconcile] fatal:', err.message);
    process.exit(2);
  });
}
