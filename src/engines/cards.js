// src/engines/cards.js — CardEngine
//
// METHODOLOGY (unchanged from cards/v1 — only the arithmetic internals were
// upgraded to exact rational math, cards/v2):
//   * A Launchfolio Card is generated when a position CLOSES (full exit) and
//     the position's total entry value meets MIN_QUALIFYING_ENTRY_USD ($10).
//   * Metrics: entry MC (weighted-average entry price * supply if known, else
//     mcap at first buy when reliably available), exit MC (mcap at final sell),
//     return %, multiple, hold duration (first buy -> last sell), ATH after
//     entry (only when reliably known — never interpolated).
//   * Every card carries provenance: wallet, mint, position id, the trade
//     signatures it was computed from, and the calculation version. A card is
//     verified = true only when ALL inputs came from verified on-chain data.
//   * Pure functions; the caller persists rows into the cards table.
//
// EXACTNESS: the qualifying-entry sum and the multiple/return computations
// run on exact rationals (money.js). Market-cap inputs are market data
// (inherently approximate) but the arithmetic on them introduces zero float
// error: multiple_raw is an exact "n/d" rational string of the given inputs.

import { fromInt, fromRawInt, fromDecimalString, add, mul, div, sub, cmp, ratToString } from './money.js';

export const MIN_QUALIFYING_ENTRY_USD = 10;
export const CALCULATION_VERSION = 'cards/v2';

const TEN = fromInt(10);
const HUNDRED = fromInt(100);

/**
 * Build a card from a closed position's verified trade history.
 *
 * @param {Object} position - { id, wallet, mint, ... } (closed)
 * @param {Array} trades - the position's verified trades, ordered by block_time asc.
 *   Each: { side, token_amount_raw?, pair_amount_raw?, pair_decimals?,
 *           usd_estimate?, mcap_at_execution?, block_time, signature }
 * @param {number|string|null} athAfterEntry - highest reliably-observed MC after entry, or null.
 * @param {Object} opts - { usdPerPairUnit }: exact rational (USD per WHOLE
 *   pair unit, e.g. $200 for 1 SOL). Preferred for the qualifying-entry
 *   computation; when null the engine falls back to summing
 *   trade.usd_estimate exactly as decimals.
 * @returns {Object|null} card row, or null if the position does not qualify.
 */
export function buildCard(position, trades, athAfterEntry = null, opts = {}) {
  if (!trades.length) return null;

  const buys = trades.filter((t) => t.side === 'BUY');
  const sells = trades.filter((t) => t.side === 'SELL');
  if (!buys.length || !sells.length) return null;

  // Qualifying entry: total USD spent on buys must reach the $10 minimum.
  // Exact rational sum — no float error at the threshold boundary.
  const usdPerPairUnit = opts.usdPerPairUnit ?? null;
  let entryUsd = fromInt(0);
  let entryUsdKnown = true;
  for (const b of buys) {
    if (usdPerPairUnit && b.pair_amount_raw != null && b.pair_decimals != null) {
      const pairWhole = fromRawInt(b.pair_amount_raw, b.pair_decimals);
      if (pairWhole === null) {
        entryUsdKnown = false;
        break;
      }
      entryUsd = add(entryUsd, mul(pairWhole, usdPerPairUnit));
    } else if (b.usd_estimate != null) {
      entryUsd = add(entryUsd, fromDecimalString(String(b.usd_estimate)));
    } else {
      entryUsdKnown = false;
      break;
    }
  }
  // Unknown entry value can never qualify — we never guess.
  if (!entryUsdKnown) return null;
  if (cmp(entryUsd, TEN) < 0) return null;

  const firstBuy = buys[0];
  const lastSell = sells[sells.length - 1];

  const entryMcap = firstBuy.mcap_at_execution ?? null;
  const exitMcap = lastSell.mcap_at_execution ?? null;

  // Return % and multiple are only computable when both MCs are reliably known.
  // Exact rational division of the given inputs — zero float error.
  let returnPct = null;
  let returnPctRaw = null;
  let multiple = null;
  let multipleRaw = null;
  if (entryMcap !== null && entryMcap !== undefined && Number(entryMcap) > 0 && exitMcap !== null && exitMcap !== undefined) {
    const entryRat = fromDecimalString(String(entryMcap));
    const exitRat = fromDecimalString(String(exitMcap));
    const multRat = div(exitRat, entryRat);
    multipleRaw = ratToString(multRat);
    multiple = Number(multRat.n) / Number(multRat.d); // legacy double, non-authoritative
    const retRat = mul(sub(multRat, fromInt(1)), HUNDRED);
    returnPctRaw = ratToString(retRat);
    returnPct = Number(retRat.n) / Number(retRat.d); // legacy double, non-authoritative
  }

  const holdDurationS =
    firstBuy.block_time && lastSell.block_time
      ? Math.max(
          0,
          Math.round(
            (new Date(lastSell.block_time) - new Date(firstBuy.block_time)) / 1000
          )
        )
      : null;

  const signatures = trades.map((t) => t.signature);

  return {
    wallet: position.wallet,
    mint: position.mint,
    position_id: position.id ?? null,
    entry_mcap: entryMcap,
    exit_mcap: exitMcap,
    // Authoritative exact fields:
    return_pct_raw: returnPctRaw,
    multiple_raw: multipleRaw,
    qualifying_entry_usd_raw: ratToString(entryUsd),
    // Legacy doubles (non-authoritative, backward compatible):
    return_pct: returnPct,
    multiple,
    hold_duration_s: holdDurationS,
    ath_after_entry: athAfterEntry, // null unless reliably observed
    qualifying_entry_usd: Number(entryUsd.n) / Number(entryUsd.d),
    trades: signatures,
    calculation_version: CALCULATION_VERSION,
    // Caller sets verified=true only when every input row is on-chain verified.
    verified: false,
  };
}
