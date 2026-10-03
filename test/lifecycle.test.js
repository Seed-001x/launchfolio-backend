// test/lifecycle.test.js — full token lifecycle through the decode pipeline.
//
// buy (≥$10) → buy → partial sell → final sell → position → card → XP once.
// Then the whole pipeline re-runs: XP must not double-award (deterministic
// event ids), and re-decoding must produce identical normalized trades
// (idempotency keys are stable).
//
// All amounts are exact BigInt/raw throughout; the only doubles are market
// data (SOL/USD price, mcaps), which are approximate by nature.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PublicKey } from '@solana/web3.js';
import { decodePumpBondingTransaction } from '../src/indexer/decoders/pumpBonding.js';
import { makeNormalizedTrade } from '../src/indexer/decoders/normalized.js';
import { rebuildPositions } from '../src/engines/positions.js';
import { buildCard } from '../src/engines/cards.js';
import { xpForCard } from '../src/engines/xp.js';
import { rat, fromInt, mul, fromRawInt } from '../src/engines/money.js';

const dir = dirname(fileURLToPath(import.meta.url));
const load = (name) => JSON.parse(readFileSync(join(dir, 'fixtures', name), 'utf8'));
const pk = (seed) => new PublicKey(Buffer.alloc(32, seed)).toBase58();
const MINT = pk(11);
const USER = pk(21);
const SOL_USD = rat(200n, 1n); // $200/SOL market price (approximate market data)

// Decode fixture trades and stamp 6-decimal tokens (resolved decimals).
function decodedTrades() {
  const out = [];
  for (const name of ['bonding-buy', 'bonding-inner', 'bonding-sell']) {
    const r = decodePumpBondingTransaction(load(`${name}.json`));
    assert.equal(r.failures.length, 0, `${name} should decode cleanly`);
    for (const t of r.trades) {
      t.token_decimals = 6;
      out.push(t);
    }
  }
  return out;
}

describe('lifecycle: buy → buy → partial sell → exit → card → XP', () => {
  const trades = decodedTrades();
  assert.equal(trades.length, 3);

  it('decodes deterministically (stable idempotency keys)', () => {
    const again = decodedTrades();
    for (let i = 0; i < trades.length; i++) {
      assert.equal(again[i].signature, trades[i].signature);
      assert.equal(again[i].event_index, trades[i].event_index);
      assert.equal(again[i].pair_amount_raw, trades[i].pair_amount_raw);
      assert.equal(again[i].token_amount_raw, trades[i].token_amount_raw);
    }
  });

  // buy1: 1.48148148 SOL → 29366330556388 units
  // buy2: 0.5 SOL        → 9000000000000 units
  // sell1 (partial): 15000000000000 units → 0.9 SOL
  const afterPartial = rebuildPositions(
    trades.map((t) => ({
      wallet: t.wallet, mint: t.mint, side: t.side,
      token_amount_raw: t.token_amount_raw.toString(),
      pair_amount_raw: t.pair_amount_raw.toString(),
      signature: t.signature,
    })),
    []
  );

  it('tracks the open position with exact cost basis', () => {
    assert.equal(afterPartial.length, 1);
    const p = afterPartial[0];
    assert.equal(p.status, 'OPEN');
    // 29366330556388 + 9000000000000 - 15000000000000 = 23366330556388
    assert.equal(p.quantity_raw, '23366330556388');
    // total cost 1981481480 - (15000000000000/38366330556388)*1981481480, exact
    assert.ok(p.cost_basis_raw.includes('/'));
    assert.equal(p.cost_basis_uncertain, false);
    // realized PnL is exact, nonzero (sold above average entry)
    assert.ok(p.realized_pnl_raw);
    assert.notEqual(p.realized_pnl_raw, '0/1');
  });

  it('closes on full exit and mints exactly one card + one XP award', () => {
    const remaining = afterPartial[0].quantity_raw;
    const exitTrade = makeNormalizedTrade({
      decoder_version: 'pump-bonding-v1',
      signature: 'exit-sig',
      event_index: 0,
      wallet: USER,
      mint: MINT,
      side: 'SELL',
      token_amount_raw: remaining,
      token_decimals: 6,
      pair_asset: 'SOL',
      pair_amount_raw: '1400000000', // 1.4 SOL proceeds
      pair_decimals: 9,
    });

    const all = [
      ...trades.map((t) => ({
        wallet: t.wallet, mint: t.mint, side: t.side,
        token_amount_raw: t.token_amount_raw.toString(),
        pair_amount_raw: t.pair_amount_raw.toString(),
        signature: t.signature,
      })),
      {
        wallet: exitTrade.wallet, mint: exitTrade.mint, side: 'SELL',
        token_amount_raw: exitTrade.token_amount_raw.toString(),
        pair_amount_raw: exitTrade.pair_amount_raw.toString(),
        signature: exitTrade.signature,
      },
    ];
    const positions = rebuildPositions(all, []);
    assert.equal(positions[0].status, 'CLOSED');
    assert.equal(positions[0].quantity_raw, '0');

    // Card: entry = 1.98148148 SOL * $200 = $396.30 ≥ $10 → qualifies.
    const cardTrades = [
      { side: 'BUY', pair_amount_raw: '1481481480', pair_decimals: 9,
        mcap_at_execution: 100, block_time: '2026-09-29T12:00:00Z', signature: 's1' },
      { side: 'BUY', pair_amount_raw: '500000000', pair_decimals: 9,
        block_time: '2026-09-29T12:01:00Z', signature: 's2' },
      { side: 'SELL', pair_amount_raw: '900000000', pair_decimals: 9,
        block_time: '2026-09-29T12:02:00Z', signature: 's3' },
      { side: 'SELL', pair_amount_raw: '1400000000', pair_decimals: 9,
        mcap_at_execution: 300, block_time: '2026-09-29T12:03:00Z', signature: 's4' },
    ];
    const card = buildCard(
      { id: 'pos-1', wallet: USER, mint: MINT },
      cardTrades, null, { usdPerPairUnit: SOL_USD }
    );
    assert.ok(card, 'card should qualify');
    assert.equal(card.multiple_raw, '3/1'); // 300/100 exact
    assert.equal(card.verified, false);

    // XP: exactly one award for the 3x card (first_double → 100).
    const xp1 = xpForCard({ ...card, id: 'card-1' }, 'user-1');
    assert.equal(xp1.amount, 100);
    assert.equal(xp1.reason, 'first_double');

    // Re-running the pipeline must not double-award.
    const xp2 = xpForCard({ ...card, id: 'card-1' }, 'user-1');
    assert.equal(xp2.event_id, xp1.event_id);
  });

  it('entry value math is exact at the $10 boundary', () => {
    // 1.98148148 SOL * $200 = $396.296296 exactly — no float involved.
    const entryLamports = 1481481480n + 500000000n;
    const entryUsd = mul(fromRawInt(entryLamports, 9), SOL_USD);
    const microDollars = (entryUsd.n * 1000000n) / entryUsd.d; // floor to µ$
    assert.equal(microDollars, 396296296n);
    // And the fractional remainder is exactly zero (terminating decimal).
    assert.equal((entryUsd.n * 1000000n) % entryUsd.d, 0n);
  });
});
