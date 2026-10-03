// test/engines.test.js — baseline engine behaviors (methodology contracts).
//
// These pin the methodology that the decode upgrade must NOT change:
// weighted-average cost basis, card qualification, XP tiers, trending
// formula, binder criteria. The v2 upgrades changed only arithmetic
// internals (float → exact BigInt/rational); every behavior below must
// hold identically.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rebuildPositions, CALCULATION_VERSION as POS_V } from '../src/engines/positions.js';
import { buildCard, CALCULATION_VERSION as CARD_V } from '../src/engines/cards.js';
import { xpForCard, xpEventId, XP_TIERS, CALCULATION_VERSION as XP_V } from '../src/engines/xp.js';
import { trendingScore, TRENDING_WEIGHTS } from '../src/engines/trending.js';
import { scoreToken, qualifiesForGenesis } from '../src/engines/binder.js';
import { ratFromString, fromInt, rat } from '../src/engines/money.js';

const W = 'wallet1';
const M = 'mint1';
const trade = (side, tokenRaw, pairRaw, extra = {}) => ({
  wallet: W, mint: M, side,
  token_amount_raw: String(tokenRaw),
  pair_amount_raw: String(pairRaw),
  signature: `sig-${side}-${tokenRaw}`,
  block_time: '2026-09-29T12:00:00Z',
  ...extra,
});

describe('positions: weighted-average cost basis (exact)', () => {
  it('merges repeat buys into one weighted-average position', () => {
    const pos = rebuildPositions([
      trade('BUY', 100n, 300n), // 3/unit
      trade('BUY', 100n, 500n), // 5/unit
    ], []);
    assert.equal(pos.length, 1);
    assert.equal(pos[0].quantity_raw, '200');
    // avg = 800/200 = 4 exactly
    assert.deepEqual(ratFromString(pos[0].cost_basis_raw), rat(4n, 1n));
    assert.equal(pos[0].status, 'OPEN');
    assert.equal(pos[0].calculation_version, POS_V);
  });

  it('computes realized PnL exactly on partial sells', () => {
    const pos = rebuildPositions([
      trade('BUY', 10n, 30n), // avg 3/unit
      trade('SELL', 4n, 20n), // 5/unit → realized 4*(5-3) = 8
    ], []);
    assert.equal(pos[0].quantity_raw, '6');
    assert.equal(pos[0].realized_pnl_raw, '8/1');
    // Remaining cost basis: 30 - (4/10)*30 = 18 over 6 = 3/unit
    assert.deepEqual(ratFromString(pos[0].cost_basis_raw), rat(3n, 1n));
    assert.equal(pos[0].status, 'OPEN');
  });

  it('closes the position on full exit', () => {
    const pos = rebuildPositions([
      trade('BUY', 10n, 30n),
      trade('SELL', 10n, 50n), // realized 10*(5-3) = 20
    ], []);
    assert.equal(pos[0].quantity_raw, '0');
    assert.equal(pos[0].cost_basis_raw, null);
    assert.equal(pos[0].realized_pnl_raw, '20/1');
    assert.equal(pos[0].status, 'CLOSED');
  });

  it('clamps sells larger than the holding (never negative quantity)', () => {
    const pos = rebuildPositions([trade('BUY', 5n, 10n), trade('SELL', 999n, 999n)], []);
    assert.equal(pos[0].quantity_raw, '0');
    assert.equal(pos[0].status, 'CLOSED');
  });

  it('has zero float error on repeating-decimal averages', () => {
    // avg = 10/3 per unit — a float would smear this.
    const pos = rebuildPositions([trade('BUY', 3n, 10n)], []);
    assert.equal(pos[0].cost_basis_raw, '10/3');
  });

  it('flags transfer-touched positions and nulls dependent PnL', () => {
    const pos = rebuildPositions(
      [trade('BUY', 10n, 30n)],
      [{ mint: M, direction: 'IN', amount_raw: '100' }]
    );
    assert.equal(pos[0].cost_basis_uncertain, true);
    assert.equal(pos[0].realized_pnl, null);
    assert.equal(pos[0].unrealized_pnl, null);
    assert.equal(pos[0].quantity_raw, '110'); // quantity still tracked
  });

  it('transfer OUT reduces quantity without inventing cost', () => {
    const pos = rebuildPositions(
      [trade('BUY', 10n, 30n)],
      [{ mint: M, direction: 'OUT', amount_raw: '4' }]
    );
    assert.equal(pos[0].quantity_raw, '6');
    assert.equal(pos[0].cost_basis_uncertain, true);
  });

  it('computes unrealized PnL only when the price is known', () => {
    const buyThen = [trade('BUY', 10n, 30n)]; // avg 3 pair-raw/unit
    const withPrice = rebuildPositions(buyThen, [], new Map([[M, rat(5n, 1n)]]));
    assert.equal(withPrice[0].unrealized_pnl_raw, '20/1'); // (5-3)*10
    const noPrice = rebuildPositions(buyThen, [], new Map());
    assert.equal(noPrice[0].unrealized_pnl, null); // never 0
  });

  it('rejects negative amounts and unknown sides', () => {
    assert.throws(() => rebuildPositions([trade('BUY', -1n, 10n)], []), RangeError);
    assert.throws(() => rebuildPositions([{ ...trade('BUY', 1n, 1n), side: 'HOLD' }], []), RangeError);
  });
});

describe('cards: qualification and exact multiples', () => {
  const closedPos = { id: 'pos1', wallet: W, mint: M };
  const mkTrades = (buyUsd, mcapIn, mcapOut) => [
    { side: 'BUY', pair_amount_raw: '1000000000', pair_decimals: 9, usd_estimate: buyUsd,
      mcap_at_execution: mcapIn, block_time: '2026-09-29T12:00:00Z', signature: 'b1' },
    { side: 'SELL', pair_amount_raw: '2500000000', pair_decimals: 9, usd_estimate: buyUsd * 2.5,
      mcap_at_execution: mcapOut, block_time: '2026-09-29T13:00:00Z', signature: 's1' },
  ];

  it('mints a card on a qualifying close with an exact multiple', () => {
    const card = buildCard(closedPos, mkTrades(12, 100, 250), null,
      { usdPerPairUnit: rat(200n, 1n) }); // $200/SOL → 1 SOL entry = $200
    assert.ok(card);
    assert.equal(card.multiple_raw, '5/2'); // exact 2.5x
    assert.equal(card.return_pct_raw, '150/1');
    assert.equal(card.hold_duration_s, 3600);
    assert.deepEqual(card.trades, ['b1', 's1']);
    assert.equal(card.calculation_version, CARD_V);
    assert.equal(card.verified, false); // caller sets true only for verified inputs
  });

  it('rejects entry below the $10 minimum (exact threshold, no float edge)', () => {
    // $9.9999999999 must NOT qualify.
    const card = buildCard(closedPos, mkTrades(9.9999999999, 100, 250));
    assert.equal(card, null);
  });

  it('never guesses when entry USD is unknown', () => {
    const trades = [
      { side: 'BUY', mcap_at_execution: 100, block_time: '2026-09-29T12:00:00Z', signature: 'b1' },
      { side: 'SELL', mcap_at_execution: 250, block_time: '2026-09-29T13:00:00Z', signature: 's1' },
    ];
    assert.equal(buildCard(closedPos, trades), null);
  });

  it('still mints without mcaps, but multiple stays null', () => {
    const trades = [
      { side: 'BUY', usd_estimate: 50, block_time: '2026-09-29T12:00:00Z', signature: 'b1' },
      { side: 'SELL', usd_estimate: 60, block_time: '2026-09-29T13:00:00Z', signature: 's1' },
    ];
    const card = buildCard(closedPos, trades);
    assert.ok(card);
    assert.equal(card.multiple_raw, null);
    assert.equal(card.multiple, null);
  });

  it('requires both a buy and a sell', () => {
    const onlyBuys = [
      { side: 'BUY', usd_estimate: 50, block_time: '2026-09-29T12:00:00Z', signature: 'b1' },
    ];
    assert.equal(buildCard(closedPos, onlyBuys), null);
    assert.equal(buildCard(closedPos, []), null);
  });
});

describe('xp: tiers on exact multiples, idempotent event ids', () => {
  const card = (multipleRaw, id = 'card1') => ({
    id, mint: M, multiple_raw: multipleRaw,
    multiple: Number(ratFromString(multipleRaw).n) / Number(ratFromString(multipleRaw).d),
  });

  it('awards the documented tier per multiple', () => {
    const cases = [
      ['10/1', 500, 'ten_bagger'],
      ['7/1', 250, 'five_bagger'],
      ['2/1', 100, 'first_double'],
      ['1/1', 25, 'profitable_close'],
      ['1/2', 10, 'completed_trade'],
    ];
    for (const [raw, xp, reason] of cases) {
      const e = xpForCard(card(raw), 'user1');
      assert.equal(e.amount, xp, `multiple ${raw}`);
      assert.equal(e.reason, reason, `multiple ${raw}`);
    }
  });

  it('prefers the exact multiple over a float artifact', () => {
    // A float 1.9999999999 must NOT demote a true 2x.
    const e = xpForCard({ id: 'c2', mint: M, multiple: 1.9999999999, multiple_raw: '2/1' }, 'u1');
    assert.equal(e.amount, 100);
    assert.equal(e.reason, 'first_double');
  });

  it('falls back to the legacy double when no exact multiple exists', () => {
    const e = xpForCard({ id: 'c3', mint: M, multiple: 5.5 }, 'u1');
    assert.equal(e.amount, 250);
  });

  it('returns null when no multiple is computable (never guesses)', () => {
    assert.equal(xpForCard({ id: 'c4', mint: M, multiple: null }, 'u1'), null);
  });

  it('produces deterministic event ids (re-ingestion is a no-op)', () => {
    const a = xpForCard(card('2/1'), 'user1');
    const b = xpForCard(card('2/1'), 'user1');
    assert.equal(a.event_id, b.event_id);
    assert.equal(a.event_id, xpEventId('card', 'card1', 'first_double'));
  });

  it('tiers match the documented XP_TIERS table', () => {
    assert.deepEqual(XP_TIERS.map((t) => [t.minMultiple, t.xp]), [
      [10, 500], [5, 250], [2, 100], [1, 25], [-Infinity, 10],
    ]);
  });
});

describe('trending: defined formula', () => {
  const maxima = { uniqueTraders: 1000, volumeSol: 500, tradesPerHour: 120 };
  const base = {
    uniqueTraders: 500, volumeSol: 250, tradesPerHour: 60,
    holderGrowthPct: 20, priceMovePct: 10, ageHours: 10,
  };

  it('scores in [0,1] with weights summing to 1', () => {
    const s = trendingScore(base, maxima);
    assert.ok(s >= 0 && s <= 1);
    const wsum = Object.values(TRENDING_WEIGHTS).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(wsum - 1) < 1e-12);
  });

  it('rewards unique traders over raw volume (wash resistance)', () => {
    const highTraders = trendingScore({ ...base, uniqueTraders: 900, volumeSol: 10 }, maxima);
    const highVolume = trendingScore({ ...base, uniqueTraders: 10, volumeSol: 490 }, maxima);
    assert.ok(highTraders > highVolume);
  });
});

describe('binder: qualification criteria', () => {
  const strong = {
    holderCount: 1000, uniqueTraders24h: 500, volume24hSol: 500,
    liquiditySol: 100, ageHours: 100, top10Concentration: 0.3, graduated: true,
  };

  it('scores a strong token at 100% and qualifies it', () => {
    const s = scoreToken(strong);
    assert.equal(s.qualification_pct, 100);
    assert.ok(qualifiesForGenesis(s));
  });

  it('rejects a weak token and never invents missing metrics', () => {
    const s = scoreToken({});
    assert.equal(s.qualification_pct, 0);
    assert.ok(!qualifiesForGenesis(s));
  });
});
