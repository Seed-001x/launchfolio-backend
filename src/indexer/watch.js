#!/usr/bin/env node
// src/indexer/watch.js — Watchlist indexer entrypoint (lean launch).
//
// Polls getSignaturesForAddress per watched mint (WATCHLIST_MINTS,
// comma-separated) instead of the full Pump program firehose — a fraction
// of the RPC cost. Pump trade transactions always reference the mint, so
// per-mint polling catches them. Reuses pump.js's decode pipeline
// (processTransaction via pollJob): Anchor events → normalized trades →
// idempotent DB writes.
//
// Run: node src/indexer/watch.js
// Env: RPC_URL (required), WATCHLIST_MINTS (required, comma-separated mints),
//      POLL_INTERVAL_MS (default 60000), PAGE_LIMIT, DATABASE_URL.

import { PublicKey } from '@solana/web3.js';
import { pollJob, finalizeConfirmations } from './pump.js';
import { DECODER_VERSIONS } from './decoders/layouts.js';

const MINTS = (process.env.WATCHLIST_MINTS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const INTERVAL = Number(process.env.POLL_INTERVAL_MS || 60000);

if (!process.env.RPC_URL) {
  console.error('[watch] RPC_URL is required');
  process.exit(1);
}
if (!MINTS.length) {
  console.error('[watch] WATCHLIST_MINTS is required');
  process.exit(1);
}

const jobs = MINTS.map((mint) => ({
  name: `watch:${mint}`,
  programId: new PublicKey(mint),
  decoderVersion: DECODER_VERSIONS.PUMP_BONDING, // bookkeeping; decode.js resolves per instruction
}));

async function main() {
  console.log(`[watch] watching ${jobs.length} mint(s), interval=${INTERVAL}ms`);
  for (;;) {
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
    await new Promise((r) => setTimeout(r, INTERVAL));
  }
}

main();
