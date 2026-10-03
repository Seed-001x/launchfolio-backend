// src/engines/positions.js — PositionEngine
//
// METHODOLOGY (documented; this is the contract the frontend relies on).
// Unchanged from positions/v1 — only the arithmetic internals were upgraded
// from floating-point to exact BigInt/rational math (positions/v2):
//
//   * Positions are reconstructed from VERIFIED trades only. Token transfers
//     are NEVER treated as buys or sells; they only set cost_basis_uncertain.
//   * Cost basis uses the WEIGHTED AVERAGE method, matching the Demo Mode
//     trading fix: each buy adds (token_amount, pair_amount); the average
//     entry price = total_pair_spent / total_tokens_bought (net of sells).
//   * Sells use the same average entry to compute realized PnL:
//         realized += (execution_price - avg_entry) * tokens_sold
//     Partial sells reduce quantity; the position stays OPEN. The position
//     CLOSES only when quantity reaches 0 (full exit).
//   * Unrealized PnL = (current_price - avg_entry) * quantity, and is only
//     computable when a current price is known — otherwise null (never 0).
//   * If tokens arrived via TRANSFER IN, cost_basis_uncertain = true and any
//     PnL that depends on the unknown entry is null. We flag; we never
//     fabricate an entry price.
//
// EXACTNESS: all amounts stay as raw on-chain integers (BigInt) through every
// calculation. Division produces exact rationals (money.js). The *_raw fields
// are authoritative; the legacy double fields are best-effort approximations
// for backward compatibility and are documented as non-authoritative.
//
// Pure functions: take rows in, return position rows out. The caller (API or
// indexer) persists them. No I/O here.

import {
  rat,
  fromInt,
  add,
  sub,
  mul,
  div,
  ZERO,
  ratToString,
  toDecimalString,
} from './money.js';

export const COST_BASIS_METHOD = 'weighted_average';
export const CALCULATION_VERSION = 'positions/v2';

/** Best-effort double from an exact rational (non-authoritative). */
function legacyDouble(r) {
  if (r === null || r === undefined) return null;
  return Number(r.n) / Number(r.d);
}

/**
 * Rebuild positions for one wallet from its verified trades + transfers.
 *
 * @param {Array} trades - verified trade rows for the wallet, ordered by block_time asc.
 *   Each: { wallet, mint, side ('BUY'|'SELL'),
 *           token_amount_raw (decimal string|BigInt, raw token units),
 *           pair_amount_raw  (decimal string|BigInt, raw pair units),
 *           signature, block_time }
 * @param {Array} transfers - transfer rows. Each: { mint, direction ('IN'|'OUT'),
 *   amount_raw (decimal string|BigInt, raw token units) }
 * @param {Map<string, Object|null>} prices - current price per mint as an exact
 *   rational in PAIR-RAW units per TOKEN-RAW unit (use money.rat / fromRawInt
 *   conversions at the call site); null when unknown → unrealized PnL is null.
 * @returns {Array} position rows ready for the positions table.
 */
export function rebuildPositions(trades, transfers, prices = new Map()) {
  const byMint = new Map();

  const acc = (mint) => {
    if (!byMint.has(mint)) {
      byMint.set(mint, {
        wallet: null,
        mint,
        quantity: 0n, // raw token units
        totalCost: ZERO, // rational, raw pair units of tokens currently held
        realizedPnl: ZERO, // rational, raw pair units
        touchedByTransfer: false,
      });
    }
    return byMint.get(mint);
  };

  for (const t of trades) {
    const p = acc(t.mint);
    p.wallet = t.wallet ?? p.wallet;
    const tokenQty = BigInt(t.token_amount_raw);
    const pairAmt = BigInt(t.pair_amount_raw);
    if (tokenQty < 0n || pairAmt < 0n) {
      throw new RangeError(`negative trade amount in ${t.signature}`);
    }
    if (t.side === 'BUY') {
      p.quantity += tokenQty;
      p.totalCost = add(p.totalCost, fromInt(pairAmt));
    } else if (t.side === 'SELL') {
      const sold = tokenQty < p.quantity ? tokenQty : p.quantity; // clamp, as v1
      if (p.quantity > 0n && sold > 0n) {
        const avgEntry = div(p.totalCost, fromInt(p.quantity)); // exact rational
        const execPrice = tokenQty > 0n ? div(fromInt(pairAmt), fromInt(tokenQty)) : ZERO;
        p.realizedPnl = add(p.realizedPnl, mul(sub(execPrice, avgEntry), fromInt(sold)));
        // Reduce cost basis proportionally to the sold fraction (exact).
        p.totalCost = sub(p.totalCost, div(mul(fromInt(sold), p.totalCost), fromInt(p.quantity)));
      }
      p.quantity -= sold;
    } else {
      throw new RangeError(`unknown trade side: ${t.side}`);
    }
  }

  for (const x of transfers) {
    const p = acc(x.mint);
    p.touchedByTransfer = true;
    const amt = BigInt(x.amount_raw);
    if (x.direction === 'IN') {
      p.quantity += amt;
      // No cost added: entry price for transferred-in tokens is unknown, so
      // the average entry now understates true cost. Flag it.
    } else if (x.direction === 'OUT') {
      p.quantity -= amt < p.quantity ? amt : p.quantity;
    } else {
      throw new RangeError(`unknown transfer direction: ${x.direction}`);
    }
  }

  const positions = [];
  for (const p of byMint.values()) {
    const qty = p.quantity;
    const avgEntry = qty > 0n ? div(p.totalCost, fromInt(qty)) : null;
    const price = prices.get(p.mint) ?? null;
    const uncertain = p.touchedByTransfer;
    const realized = uncertain ? null : p.realizedPnl;
    const unrealized =
      !uncertain && avgEntry !== null && price !== null
        ? mul(sub(price, avgEntry), fromInt(qty))
        : null;
    positions.push({
      wallet: p.wallet,
      mint: p.mint,
      // Authoritative exact fields:
      quantity_raw: qty.toString(),
      cost_basis_raw: avgEntry ? ratToString(avgEntry) : null,
      cost_basis_method: COST_BASIS_METHOD,
      cost_basis_uncertain: uncertain,
      realized_pnl_raw: realized ? ratToString(realized) : null,
      unrealized_pnl_raw: unrealized ? ratToString(unrealized) : null,
      status: qty > 0n ? 'OPEN' : 'CLOSED',
      calculation_version: CALCULATION_VERSION,
      // Legacy best-effort doubles (non-authoritative, backward compatible):
      quantity: Number(qty),
      cost_basis: legacyDouble(avgEntry),
      realized_pnl: legacyDouble(realized),
      unrealized_pnl: legacyDouble(unrealized),
    });
  }
  return positions;
}
