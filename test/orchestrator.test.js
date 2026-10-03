// test/orchestrator.test.js — decode.js orchestration logic with a mock pool.
//
// Verifies WITHOUT a live database: idempotent SQL patterns, failed-tx
// exclusion, failure queueing, graduation idempotency, decimals resolution
// paths, and the launch_origin protection (never downgraded by the indexer).

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PublicKey } from '@solana/web3.js';
import {
  processTransaction,
  resolveTokenDecimals,
  clearDecimalsCache,
} from '../src/indexer/decode.js';

const dir = dirname(fileURLToPath(import.meta.url));
const load = (name) => JSON.parse(readFileSync(join(dir, 'fixtures', name), 'utf8'));
const pk = (seed) => new PublicKey(Buffer.alloc(32, seed)).toBase58();

// Mock pg pool: records every query, returns canned results by SQL pattern.
function mockPool(handlers = {}) {
  const queries = [];
  const pool = {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      for (const [pattern, result] of Object.entries(handlers)) {
        if (sql.includes(pattern)) return result(sql, params);
      }
      return { rows: [], rowCount: 1 };
    },
  };
  return pool;
}

const emptyRows = () => ({ rows: [], rowCount: 0 });
const baseHandlers = {
  'SELECT decimals FROM tokens': emptyRows,
  'SELECT base_decimals FROM amm_pools': emptyRows,
  'SELECT pool, base_mint, quote_mint': emptyRows, // poolResolver snapshot
  'SELECT 1 FROM launch_records': emptyRows,
};

function mintAccountInfo(decimals) {
  const buf = Buffer.alloc(82);
  buf.writeUInt8(decimals, 44); // SPL mint layout: decimals at byte 44
  return { data: buf };
}

describe('processTransaction orchestration', () => {
  beforeEach(() => clearDecimalsCache());

  it('persists decoded trades idempotently with exact raw amounts', async () => {
    const pool = mockPool(baseHandlers);
    const stats = await processTransaction(pool, load('bonding-multi.json'), {
      job: 'test-job',
      getMintAccountInfo: async () => mintAccountInfo(6),
    });

    assert.equal(stats.txs_decoded, 1);
    assert.equal(stats.events_failed, 0);

    const tradeInserts = pool.queries.filter((q) => q.sql.includes('INSERT INTO trades'));
    assert.equal(tradeInserts.length, 1); // one trade event in the fixture
    const ins = tradeInserts[0];
    assert.ok(ins.sql.includes('ON CONFLICT (signature, event_index) DO NOTHING'));
    // Exact raw amounts in the params (positions 12/13: token_amount_raw, pair_amount_raw).
    const p = ins.params;
    assert.equal(p[11], '20000000000000'); // token_amount_raw
    assert.equal(p[12], '1000000000'); // pair_amount_raw
    assert.equal(p[13], 6); // token_decimals from RPC byte 44
    assert.equal(p[14], 9); // pair_decimals (SOL)
    assert.equal(p[15], 'pump-bonding-v1');
    // Fee breakdown preserved as JSON.
    const fees = JSON.parse(p[19]);
    assert.equal(fees.fee_protocol_raw, '14074075');

    // Launch upserted the token.
    const tokenUpserts = pool.queries.filter((q) => q.sql.includes('INSERT INTO tokens'));
    assert.ok(tokenUpserts.length >= 1);
    // launch_origin is NEVER overwritten by the indexer.
    assert.ok(!tokenUpserts[0].sql.includes('launch_origin = EXCLUDED'));

    // Stats bumped.
    assert.ok(pool.queries.some((q) => q.sql.includes('INSERT INTO indexer_stats')));
  });

  it('excludes failed transactions from ALL economic writes', async () => {
    const pool = mockPool(baseHandlers);
    const stats = await processTransaction(pool, load('bonding-failed.json'), {
      job: 'test-job',
      getMintAccountInfo: async () => mintAccountInfo(6),
    });
    assert.equal(stats.txs_skipped_failed, 1);
    assert.equal(stats.txs_decoded, 0);
    const writes = pool.queries.filter((q) =>
      /INSERT INTO (trades|tokens|fee_events)/.test(q.sql)
    );
    assert.equal(writes.length, 0);
  });

  it('persists fee events with NULL-safe idempotency keys', async () => {
    const pool = mockPool(baseHandlers);
    await processTransaction(pool, load('bonding-buy.json'), {
      job: 'test-job',
      getMintAccountInfo: async () => mintAccountInfo(6),
    });
    const feeInserts = pool.queries.filter((q) => q.sql.includes('INSERT INTO fee_events'));
    assert.ok(feeInserts.length >= 2); // protocol_fee + creator_fee at least
    for (const ins of feeInserts) {
      assert.ok(ins.sql.includes('ON CONFLICT (dedupe_key) DO NOTHING'));
      const key = ins.params[11];
      assert.equal(typeof key, 'string');
      assert.equal(key.length, 64); // sha256 hex
    }
    // Network fee captured exactly from tx meta.
    const net = feeInserts.find((q) => q.params[2] === 'network_fee');
    assert.ok(net, 'network_fee event recorded');
  });

  it('queues decode failures instead of dropping them', async () => {
    const pool = mockPool(baseHandlers);
    const stats = await processTransaction(pool, load('amm-unknown-pool.json'), {
      job: 'test-job',
    });
    assert.equal(stats.events_failed, 1);
    const queued = pool.queries.filter((q) => q.sql.includes('INSERT INTO decode_failures'));
    assert.equal(queued.length, 1);
    assert.match(queued[0].params[3], /pool-resolution/);
    assert.equal(queued[0].params[2], 'test-job');
  });

  it('applies graduation as an idempotent lifecycle update (no duplicate token)', () => {
    return (async () => {
      const pool = mockPool({
        ...baseHandlers,
        // The graduation fixture also carries a CreatePoolEvent for the AMM.
        'SELECT pool, base_mint, quote_mint': () => ({
          rows: [{
            base_mint: pk(11),
            quote_mint: 'So11111111111111111111111111111111111111112',
            base_decimals: 6, quote_decimals: 9,
          }],
          rowCount: 1,
        }),
      });
      await processTransaction(pool, load('bonding-graduation.json'), { job: 'test-job' });
      const updates = pool.queries.filter((q) =>
        q.sql.includes("SET launch_state = 'graduated'")
      );
      assert.equal(updates.length, 1);
      // Guard: graduation applies exactly once per mint, keyed on the
      // authoritative graduation_signature — replay-safe, and an out-of-order
      // migration event still backfills signature/time even if the row was
      // already labeled 'graduated' via its pool.
      assert.ok(updates[0].sql.includes('graduation_signature IS NULL'));
      // Pool seeded for future trade attribution.
      assert.ok(pool.queries.some((q) => q.sql.includes('INSERT INTO amm_pools')));
    })();
  });

  it('upgrades launch_origin to LAUNCHFOLIO only via launch_records', async () => {
    const withRecord = mockPool({
      ...baseHandlers,
      'SELECT 1 FROM launch_records': () => ({ rows: [{ '?column?': 1 }], rowCount: 1 }),
    });
    await processTransaction(withRecord, load('bonding-create.json'), { job: 'test-job' });
    const upgrades = withRecord.queries.filter((q) => q.sql.includes("launch_origin = 'LAUNCHFOLIO'"));
    assert.equal(upgrades.length, 1);
    // The upgrade never downgrades: guarded by launch_origin <> 'LAUNCHFOLIO'.
    assert.ok(upgrades[0].sql.includes("AND launch_origin <> 'LAUNCHFOLIO'"));

    const withoutRecord = mockPool(baseHandlers);
    await processTransaction(withoutRecord, load('bonding-create.json'), { job: 'test-job' });
    const noUpgrades = withoutRecord.queries.filter((q) =>
      q.sql.includes("launch_origin = 'LAUNCHFOLIO'")
    );
    assert.equal(noUpgrades.length, 0);
  });
});

describe('resolveTokenDecimals', () => {
  beforeEach(() => clearDecimalsCache());
  const MINT = pk(11);

  it('returns null (never a guess) when unresolvable', async () => {
    const pool = mockPool(baseHandlers);
    const r = await resolveTokenDecimals(pool, MINT, async () => null);
    assert.equal(r.decimals, null);
    assert.equal(r.source, 'unresolvable'); // account definitively absent
    const r2 = await resolveTokenDecimals(pool, MINT, async () => { throw new Error('must not be called'); });
    assert.equal(r2.decimals, null);
    assert.equal(r2.source, 'cache'); // cached negative, no RPC hammering
  });

  it('prefers DB, then AMM pool, then RPC byte 44', async () => {
    const dbHit = mockPool({
      ...baseHandlers,
      'SELECT decimals FROM tokens': () => ({ rows: [{ decimals: 9 }], rowCount: 1 }),
    });
    assert.equal((await resolveTokenDecimals(dbHit, MINT, async () => { throw new Error('no rpc'); })).decimals, 9);

    clearDecimalsCache();
    const poolHit = mockPool({
      ...baseHandlers,
      'SELECT base_decimals FROM amm_pools': () => ({ rows: [{ base_decimals: 6 }], rowCount: 1 }),
    });
    const r2 = await resolveTokenDecimals(poolHit, MINT, async () => { throw new Error('no rpc'); });
    assert.equal(r2.decimals, 6);
    assert.equal(r2.source, 'amm_pool');

    clearDecimalsCache();
    const rpcPool = mockPool(baseHandlers);
    const r3 = await resolveTokenDecimals(rpcPool, MINT, async () => mintAccountInfo(6));
    assert.equal(r3.decimals, 6);
    assert.equal(r3.source, 'rpc');
    // Second call hits the memory cache (no more RPC).
    let rpcCalls = 0;
    const r4 = await resolveTokenDecimals(rpcPool, MINT, async () => { rpcCalls++; return null; });
    assert.equal(r4.decimals, 6);
    assert.equal(rpcCalls, 0);
  });
});
