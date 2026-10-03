// test/decoders.test.js — PumpBondingDecoder + PumpSwapDecoder over fixtures.
//
// Covers: exact buy/sell amounts, fee semantics (buy=gross spend, sell=net
// proceeds), launch + graduation detection, multi-event txs, inner (CPI)
// instructions, failed-tx exclusion, v0 messages, unknown data, unknown
// pools, and per-event idempotency keys.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePumpBondingTransaction } from '../src/indexer/decoders/pumpBonding.js';
import { decodePumpSwapTransaction } from '../src/indexer/decoders/pumpSwap.js';
import { DECODER_VERSIONS } from '../src/indexer/decoders/layouts.js';

const dir = dirname(fileURLToPath(import.meta.url));
const load = (name) => JSON.parse(readFileSync(join(dir, 'fixtures', name), 'utf8'));

// Pool info matching the graduation fixture's CreatePoolEvent (decimals 6/9).
const POOL_INFO = {
  base_mint: 'gvd5apx7JoQUsxvEHJpgpmxL3KqfyD3yLqL6H4K5Z6H', // placeholder, replaced below
  quote_mint: 'So11111111111111111111111111111111111111112',
  base_decimals: 6,
  quote_decimals: 9,
};

import { PublicKey } from '@solana/web3.js';
const pk = (seed) => new PublicKey(Buffer.alloc(32, seed)).toBase58();
POOL_INFO.base_mint = pk(11); // == MINT in build.js

const resolveKnownPool = (poolAddr) => (poolAddr === pk(24) ? POOL_INFO : null);

describe('PumpBondingDecoder', () => {
  it('decodes a top-level buy with exact amounts (buy = gross spend)', () => {
    const out = decodePumpBondingTransaction(load('bonding-buy.json'));
    assert.equal(out.trades.length, 1);
    assert.equal(out.failures.length, 0);
    const t = out.trades[0];
    assert.equal(t.decoder_version, DECODER_VERSIONS.PUMP_BONDING);
    assert.equal(t.side, 'BUY');
    assert.equal(t.pair_amount_raw, 1481481480n); // user's total spend
    assert.equal(t.token_amount_raw, 29366330556388n);
    assert.equal(t.pair_asset, 'SOL');
    assert.equal(t.pair_decimals, 9);
    assert.equal(t.token_decimals, null); // resolved by orchestrator, never guessed
    assert.equal(t.event_index, 0);
    assert.equal(t.instruction_index, 0);
    assert.equal(t.inner_instruction_index, 0);
    assert.equal(t.ix_name, 'buy');
    // Exact fee breakdown for accounting.
    assert.equal(t.fee_protocol_raw, 14074075n);
    assert.equal(t.fee_creator_raw, 4444445n);
  });

  it('decodes the REAL mainnet buy identically', () => {
    const out = decodePumpBondingTransaction(load('tx_buy_real.json'));
    assert.equal(out.trades.length, 1);
    assert.equal(out.failures.length, 0);
    const t = out.trades[0];
    assert.equal(t.side, 'BUY');
    assert.equal(t.pair_amount_raw, 1481481480n);
    assert.equal(t.token_amount_raw, 29366330556388n);
    // Inner instruction attribution (routed through an aggregator: invoke [2]).
    assert.ok(t.inner_instruction_index >= 1, 'expected inner (CPI) attribution');
  });

  it('decodes a sell (sell = net proceeds)', () => {
    const out = decodePumpBondingTransaction(load('bonding-sell.json'));
    assert.equal(out.trades.length, 1);
    const t = out.trades[0];
    assert.equal(t.side, 'SELL');
    assert.equal(t.pair_amount_raw, 900000000n);
    assert.equal(t.token_amount_raw, 15000000000000n);
    assert.equal(t.ix_name, 'sell');
  });

  it('detects launches with creator and metadata', () => {
    const out = decodePumpBondingTransaction(load('bonding-create.json'));
    assert.equal(out.launches.length, 1);
    assert.equal(out.trades.length, 0);
    const l = out.launches[0];
    assert.equal(l.mint, pk(11));
    assert.equal(l.creator, pk(22));
    assert.equal(l.name, 'Test Token');
    assert.equal(l.ticker, 'TEST');
    assert.equal(l.launch_origin, 'EXTERNAL_PUMP'); // decoder never infers Launchfolio
  });

  it('detects graduation via the migration event (no duplicate token)', () => {
    const out = decodePumpBondingTransaction(load('bonding-graduation.json'));
    assert.equal(out.graduations.length, 1);
    const g = out.graduations[0];
    assert.equal(g.mint, pk(11));
    assert.equal(g.pool, pk(24));
    assert.equal(out.trades.length, 0);
  });

  it('handles multiple events in one tx with distinct event indices', () => {
    const out = decodePumpBondingTransaction(load('bonding-multi.json'));
    assert.equal(out.launches.length, 1);
    assert.equal(out.trades.length, 1);
    assert.equal(out.launches[0].event_index, 0);
    assert.equal(out.trades[0].event_index, 1);
    assert.equal(out.trades[0].instruction_index, 1); // second instruction
  });

  it('attributes inner-instruction (CPI) events to the right instruction', () => {
    const out = decodePumpBondingTransaction(load('bonding-inner.json'));
    assert.equal(out.trades.length, 1);
    const t = out.trades[0];
    assert.equal(t.instruction_index, 0); // the router's top-level instruction
    assert.equal(t.inner_instruction_index, 1); // first inner call
    assert.equal(t.pair_amount_raw, 500000000n);
  });

  it('EXCLUDES failed transactions from all economic state', () => {
    const out = decodePumpBondingTransaction(load('bonding-failed.json'));
    assert.equal(out.skipped, 'failed-transaction');
    assert.equal(out.trades.length, 0);
    assert.equal(out.launches.length, 0);
    assert.equal(out.graduations.length, 0);
    assert.equal(out.feeEvents.length, 0);
  });

  it('decodes v0 versioned transactions', () => {
    const out = decodePumpBondingTransaction(load('v0-tx.json'));
    assert.equal(out.trades.length, 1);
    assert.equal(out.trades[0].side, 'SELL');
    assert.equal(out.trades[0].ix_name, 'sell_v2');
    assert.equal(out.failures.length, 0);
  });

  it('skips unknown Program data without failing', () => {
    const out = decodePumpBondingTransaction(load('unknown-data.json'));
    assert.equal(out.trades.length, 0);
    assert.equal(out.failures.length, 0);
  });

  it('emits per-trade fee events for accounting (no payouts)', () => {
    const out = decodePumpBondingTransaction(load('bonding-buy.json'));
    const types = out.feeEvents.map((f) => f.fee_type).sort();
    assert.ok(types.includes('protocol_fee'));
    assert.ok(types.includes('creator_fee'));
    const proto = out.feeEvents.find((f) => f.fee_type === 'protocol_fee');
    assert.equal(proto.amount_raw, 14074075n);
    assert.equal(proto.attribution, 'event');
  });
});

describe('PumpSwapDecoder', () => {
  it('decodes an AMM buy with pool attribution', () => {
    const out = decodePumpSwapTransaction(load('amm-buy.json'), { resolvePool: resolveKnownPool });
    assert.equal(out.trades.length, 1);
    assert.equal(out.failures.length, 0);
    const t = out.trades[0];
    assert.equal(t.decoder_version, DECODER_VERSIONS.PUMP_SWAP);
    assert.equal(t.side, 'BUY');
    assert.equal(t.mint, pk(11));
    assert.equal(t.token_amount_raw, 1000000000n); // base_amount_out
    assert.equal(t.pair_amount_raw, 2000000n); // user_quote_amount_in
    assert.equal(t.pair_asset, 'SOL'); // WSOL quote normalizes to SOL
    assert.equal(t.token_decimals, 6);
    assert.equal(t.pair_decimals, 9);
    assert.equal(t.fee_lp_raw, 50000n);
    assert.equal(t.fee_protocol_raw, 10000n);
    assert.equal(t.fee_creator_raw, 50000n);
  });

  it('decodes an AMM sell (net proceeds)', () => {
    const out = decodePumpSwapTransaction(load('amm-sell.json'), { resolvePool: resolveKnownPool });
    assert.equal(out.trades.length, 1);
    const t = out.trades[0];
    assert.equal(t.side, 'SELL');
    assert.equal(t.token_amount_raw, 1000000000n); // base_amount_in
    assert.equal(t.pair_amount_raw, 1900000n); // user_quote_amount_out
  });

  it('seeds pool creations from CreatePoolEvent (decimals authority)', () => {
    const out = decodePumpSwapTransaction(load('bonding-graduation.json'), {
      resolvePool: () => null,
    });
    assert.equal(out.poolCreations.length, 1);
    const p = out.poolCreations[0];
    assert.equal(p.pool, pk(24));
    assert.equal(p.base_mint, pk(11));
    assert.equal(p.base_decimals, 6);
    assert.equal(p.quote_decimals, 9);
  });

  it('FAILS (never guesses) on an unknown pool', () => {
    const out = decodePumpSwapTransaction(load('amm-unknown-pool.json'), {
      resolvePool: () => null,
    });
    assert.equal(out.trades.length, 0);
    assert.equal(out.failures.length, 1);
    assert.match(out.failures[0].stage, /pool-resolution/);
    assert.match(out.failures[0].error, /cannot be attributed/);
  });
});
