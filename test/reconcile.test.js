// test/reconcile.test.js — balance reconciliation (STEP 12).
//
// Unit tests for reconcileTradeAmounts plus end-to-end coverage through
// processTransaction with a mock pool: clean fixtures reconcile silently,
// tampered balances queue a 'reconcile:trade' failure with the raw tx meta
// preserved, and the trade is STILL stored (event authoritative).

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PublicKey } from '@solana/web3.js';
import {
  reconcileTradeAmounts,
  ATA_RENT_LAMPORTS,
  DUST_LAMPORTS,
} from '../src/indexer/reconcileTrade.js';
import { decodePumpBondingTransaction } from '../src/indexer/decoders/pumpBonding.js';
import { processTransaction, clearDecimalsCache } from '../src/indexer/decode.js';
import { PROGRAM_IDS } from '../src/indexer/decoders/layouts.js';

const dir = dirname(fileURLToPath(import.meta.url));
const load = (name) => JSON.parse(readFileSync(join(dir, 'fixtures', name), 'utf8'));
const pk = (seed) => new PublicKey(Buffer.alloc(32, seed)).toBase58();

const W = pk(21); // trader / fee payer
const MINT = pk(11);
const FEE = 5000;

function tb(accountIndex, mint, owner, amount, decimals = 6) {
  return {
    accountIndex, mint, owner,
    uiTokenAmount: { amount: String(amount), decimals },
  };
}

// Minimal trade + tx builders for unit tests.
function trade(over = {}) {
  return {
    signature: 'sig111',
    wallet: W,
    mint: MINT,
    side: 'BUY',
    token_amount_raw: '1000',
    pair_amount_raw: '5000',
    pair_asset: 'SOL',
    quote_mint: null,
    inner_instruction_index: null,
    token_decimals: 6,
    pair_decimals: 9,
    ...over,
  };
}

function tx({ pre, post, fee = FEE, feePayer = W, preTB = [], postTB = [], keys = [W, 'Other'] } = {}) {
  const k = feePayer === W ? keys : [feePayer, W];
  const preB = feePayer === W ? [pre, 1e9] : [1e9, pre];
  const postB = feePayer === W ? [post, 1e9] : [1e9, post];
  return {
    transaction: { signatures: ['sig111'], message: { accountKeys: k } },
    meta: { fee, preBalances: preB, postBalances: postB, preTokenBalances: preTB, postTokenBalances: postTB },
  };
}

describe('reconcileTradeAmounts', () => {
  it('passes an exact direct buy (new ATA rent accounted)', () => {
    const t = trade();
    const x = tx({
      pre: 10_000_000,
      post: 10_000_000 - 5000 - FEE - ATA_RENT_LAMPORTS,
      postTB: [tb(2, MINT, W, 1000)],
    });
    const r = reconcileTradeAmounts(t, x);
    assert.equal(r.mismatch, false);
    assert.equal(r.checks.token.status, 'ok');
    assert.equal(r.checks.quote.status, 'ok');
  });

  it('passes a direct sell matching the rent-return hypothesis', () => {
    const t = trade({ side: 'SELL', token_amount_raw: '400', pair_amount_raw: '8000' });
    // Trader sells 400 tokens for 8,000 lamports and closes the ATA in-tx.
    const x = tx({
      pre: 10_000_000,
      post: 10_000_000 + 8000 - FEE + ATA_RENT_LAMPORTS,
      preTB: [tb(2, MINT, W, 400)],
      postTB: [],
    });
    const r = reconcileTradeAmounts(t, x);
    assert.equal(r.mismatch, false);
    assert.equal(r.checks.token.status, 'ok');
    assert.equal(r.checks.quote.status, 'ok');
    assert.match(r.checks.quote.hypothesis, /rent return/);
  });

  it('flags a token-amount mismatch without hiding the trade', () => {
    const t = trade({ token_amount_raw: '1000' });
    const x = tx({
      pre: 10_000_000,
      post: 10_000_000 - 5000 - FEE - ATA_RENT_LAMPORTS,
      postTB: [tb(2, MINT, W, 999)], // one unit short
    });
    const r = reconcileTradeAmounts(t, x);
    assert.equal(r.mismatch, true);
    assert.equal(r.checks.token.status, 'mismatch');
    assert.equal(r.checks.quote.status, 'ok'); // SOL side still fine
    assert.match(r.checks.token.reason, /999/);
  });

  it('flags a SOL-side mismatch', () => {
    const t = trade();
    const x = tx({
      pre: 10_000_000,
      post: 10_000_000 - 5000 - FEE - ATA_RENT_LAMPORTS - 1_000_000, // 1M unexplained
      postTB: [tb(2, MINT, W, 1000)],
    });
    const r = reconcileTradeAmounts(t, x);
    assert.equal(r.mismatch, true);
    assert.equal(r.checks.quote.status, 'mismatch');
    assert.equal(r.checks.token.status, 'ok');
  });

  it('tolerates dust within DUST_LAMPORTS but not above', () => {
    const t = trade();
    const base = (over) => tx({
      pre: 10_000_000,
      post: 10_000_000 - 5000 - FEE - ATA_RENT_LAMPORTS + over,
      postTB: [tb(2, MINT, W, 1000)],
    });
    assert.equal(reconcileTradeAmounts(t, base(DUST_LAMPORTS)).mismatch, false);
    assert.equal(reconcileTradeAmounts(t, base(DUST_LAMPORTS + 1)).mismatch, true);
  });

  it('skips the quote check for aggregator-routed trades but enforces the token check', () => {
    const t = trade({ inner_instruction_index: 2 });
    const x = tx({
      pre: 10_000_000,
      post: 1_000_000, // router economics: deliberately inconsistent
      postTB: [tb(2, MINT, W, 1000)],
    });
    const r = reconcileTradeAmounts(t, x);
    assert.equal(r.checks.quote.status, 'skipped');
    assert.match(r.checks.quote.reason, /aggregator-routed/);
    assert.equal(r.checks.token.status, 'ok');
    assert.equal(r.mismatch, false);
  });

  it('reports unavailable (not mismatch) when token-balance data is missing', () => {
    const t = trade();
    const bad = tx({ pre: 10_000_000, post: 9_000_000 });
    delete bad.meta.preTokenBalances;
    const r = reconcileTradeAmounts(t, bad);
    assert.equal(r.mismatch, false);
    assert.equal(r.checks.token.status, 'unavailable');
    assert.equal(r.checks.quote.status, 'unavailable');
  });

  it('does not attribute the network fee when someone else paid it', () => {
    const other = pk(77);
    const t = trade();
    const x = tx({
      pre: 10_000_000,
      post: 10_000_000 - 5000 - ATA_RENT_LAMPORTS, // no fee: relayer paid
      feePayer: other,
      postTB: [tb(2, MINT, W, 1000)],
    });
    const r = reconcileTradeAmounts(t, x);
    assert.equal(r.mismatch, false);
    assert.equal(r.checks.quote.status, 'ok');
  });

  it('sums WSOL and SOL flows for token-quoted trades', () => {
    const WSOL = 'So11111111111111111111111111111111111111112';
    const t = trade({
      side: 'SELL', token_amount_raw: '1000000', pair_amount_raw: '1900000',
      quote_mint: WSOL,
    });
    // Trader had 10M WSOL, received 1.9M, unwrapped all, closed the account.
    const x = tx({
      pre: 10_000_000,
      post: 10_000_000 + 11_900_000 - FEE + ATA_RENT_LAMPORTS,
      preTB: [tb(2, WSOL, W, 10000000, 9), tb(3, MINT, W, 5000000)],
      postTB: [tb(3, MINT, W, 4000000)],
    });
    const r = reconcileTradeAmounts(t, x);
    assert.equal(r.mismatch, false);
    assert.equal(r.checks.token.status, 'ok');
    assert.equal(r.checks.quote.status, 'ok');
  });

  it('real mainnet buy: token side exact, quote side skipped (routed)', () => {
    const realTx = load('tx_buy_real.json');
    const decoded = decodePumpBondingTransaction(realTx, {});
    assert.equal(decoded.trades.length, 1);
    const r = reconcileTradeAmounts(decoded.trades[0], realTx);
    // Token delta matched the decoded amount to the unit on mainnet.
    assert.equal(r.checks.token.status, 'ok');
    // Aggregator-routed: SOL check honestly skipped, not faked.
    assert.equal(r.checks.quote.status, 'skipped');
    assert.equal(r.mismatch, false);
  });
});

// Mock pg pool: records queries, canned results by SQL pattern.
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
  'SELECT pool, base_mint, quote_mint': emptyRows,
  'SELECT 1 FROM launch_records': emptyRows,
};

function mintAccountInfo(decimals) {
  const buf = Buffer.alloc(82);
  buf.writeUInt8(decimals, 44);
  return { data: buf };
}

const tradeInserts = (pool) => pool.queries.filter((q) => q.sql.includes('INSERT INTO trades'));
const reconcileFailures = (pool) =>
  pool.queries.filter(
    (q) => q.sql.includes('INSERT INTO decode_failures') && q.params[3] === 'reconcile:trade'
  );

describe('processTransaction reconciliation', () => {
  beforeEach(() => clearDecimalsCache());

  it('clean fixtures reconcile silently (no failure rows, zero mismatches)', async () => {
    for (const name of ['bonding-buy.json', 'bonding-sell.json', 'bonding-multi.json',
      'bonding-tiny.json', 'bonding-unrelated.json', 'bonding-legacy-trade.json', 'v0-tx.json']) {
      const pool = mockPool(baseHandlers);
      const stats = await processTransaction(pool, load(name), {
        job: 'test-job',
        getMintAccountInfo: async () => mintAccountInfo(6),
      });
      assert.equal(stats.reconcile_mismatches, 0, `${name}: expected zero mismatches`);
      assert.equal(reconcileFailures(pool).length, 0, `${name}: expected no reconcile failures`);
    }
  });

  it('AMM fixtures reconcile through the WSOL wrap/unwrap model', async () => {
    const poolInfo = {
      base_mint: pk(11),
      quote_mint: 'So11111111111111111111111111111111111111112',
      base_decimals: 6, quote_decimals: 9,
    };
    for (const name of ['amm-buy.json', 'amm-sell.json']) {
      const pool = mockPool({
        ...baseHandlers,
        'SELECT pool, base_mint, quote_mint': () => ({ rows: [{ pool: pk(24), ...poolInfo }], rowCount: 1 }),
      });
      const stats = await processTransaction(pool, load(name), { job: 'test-job' });
      assert.equal(stats.reconcile_mismatches, 0, `${name}: expected zero mismatches`);
      assert.equal(reconcileFailures(pool).length, 0);
    }
  });

  it('tampered balances queue a reconcile failure WITH raw tx — trade still stored', async () => {
    const pool = mockPool(baseHandlers);
    const bad = load('bonding-buy.json');
    bad.meta.postBalances[0] += 1_000_000; // 1M lamports appear from nowhere
    const stats = await processTransaction(pool, bad, {
      job: 'test-job',
      getMintAccountInfo: async () => mintAccountInfo(6),
    });
    assert.equal(stats.reconcile_mismatches, 1);
    // The trade is authoritative: still inserted.
    assert.equal(tradeInserts(pool).length, 1);
    // The mismatch is queued, never silent, with raw tx meta preserved.
    const fails = reconcileFailures(pool);
    assert.equal(fails.length, 1);
    assert.equal(fails[0].params[2], 'test-job');
    assert.match(fails[0].params[4], /reconcile mismatch/);
    const rawTx = JSON.parse(fails[0].params[5]);
    assert.ok(Array.isArray(rawTx.preBalances));
    assert.ok(Array.isArray(rawTx.postTokenBalances));
    // indexer_stats carries the tripwire counter.
    const statUpdates = pool.queries.filter((q) => q.sql.includes('reconcile_mismatches'));
    assert.ok(statUpdates.length >= 1);
    assert.equal(statUpdates[statUpdates.length - 1].params[6], 1);
  });

  it('duplicate replay stays clean and idempotent', async () => {
    const pool = mockPool(baseHandlers);
    const opts = { job: 'test-job', getMintAccountInfo: async () => mintAccountInfo(6) };
    const s1 = await processTransaction(pool, load('bonding-buy.json'), opts);
    const s2 = await processTransaction(pool, load('bonding-buy.json'), opts);
    assert.equal(s1.reconcile_mismatches, 0);
    assert.equal(s2.reconcile_mismatches, 0);
    assert.equal(reconcileFailures(pool).length, 0);
    // Both passes attempt the insert; the DB dedupes via ON CONFLICT.
    assert.equal(tradeInserts(pool).length, 2);
    assert.ok(tradeInserts(pool).every((q) => q.sql.includes('ON CONFLICT (signature, event_index) DO NOTHING')));
  });

  it('provenance + exact normalized amounts land on the trade row', async () => {
    const pool = mockPool(baseHandlers);
    await processTransaction(pool, load('bonding-tiny.json'), {
      job: 'test-job',
      getMintAccountInfo: async () => mintAccountInfo(6),
    });
    const ins = tradeInserts(pool)[0];
    const p = ins.params;
    // New columns appended after the legacy 20 — existing positions untouched.
    assert.equal(p[20], PROGRAM_IDS.PUMP); // program
    assert.equal(p[21], 'buy'); // ix_name
    assert.equal(p[22], 'TradeEvent'); // event_name
    assert.equal(p[23], '0.001'); // token_amount_normalized (exact, not float)
    assert.equal(p[24], '0.000007'); // pair_amount_normalized
  });

  it('swap-first-seen token row is labeled graduated; graduation event still backfills', async () => {
    const poolInfo = {
      base_mint: pk(11),
      quote_mint: 'So11111111111111111111111111111111111111112',
      base_decimals: 6, quote_decimals: 9,
    };
    const pool = mockPool({
      ...baseHandlers,
      'SELECT pool, base_mint, quote_mint': () => ({ rows: [{ pool: pk(24), ...poolInfo }], rowCount: 1 }),
    });
    await processTransaction(pool, load('amm-buy.json'), { job: 'test-job' });
    const tokenUpserts = pool.queries.filter((q) =>
      q.sql.includes('INSERT INTO tokens') && q.sql.includes('pool_address')
    );
    assert.equal(tokenUpserts.length, 1);
    assert.match(tokenUpserts[0].sql, /'graduated'/);
    // An existing 'bonding' row is NOT relabeled by swap activity alone.
    assert.match(tokenUpserts[0].sql, /graduation_signature IS NOT NULL/);

    // The authoritative migration event still applies when it arrives later.
    const pool2 = mockPool({
      ...baseHandlers,
      'SELECT pool, base_mint, quote_mint': () => ({ rows: [{ pool: pk(24), ...poolInfo }], rowCount: 1 }),
    });
    await processTransaction(pool2, load('bonding-graduation.json'), { job: 'test-job' });
    const gradUpdates = pool2.queries.filter((q) => q.sql.includes("SET launch_state = 'graduated'"));
    assert.equal(gradUpdates.length, 1);
    assert.ok(gradUpdates[0].sql.includes('graduation_signature IS NULL'));
  });
});
