// src/indexer/settle.js — positions → cards → XP settlement pipeline.
//
// The engines (positions, cards, xp) are pure functions. This module is the
// pipeline that RUNS them: after each index cycle, it finds (wallet, mint)
// pairs with new trades, rebuilds their positions from verified trade
// history, persists them, mints cards for newly-closed positions, and awards
// XP for those cards. Everything is idempotent:
//   positions: upsert on (wallet, mint)
//   cards:     unique (wallet, mint, position_id) — one card per round-trip
//   xp_events: deterministic event_id, INSERT ... ON CONFLICT DO NOTHING
//
// Boundaries (do not move):
//   * XP comes ONLY from closed-position cards (verified trades). Launching
//     a token awards no XP — never add a launch-XP path here.
//   * Unknown values stay null (price, multiple, usd) — never fabricated.
//   * Transfers are tracked for cost-basis uncertainty but never treated as
//     trades.

import { rebuildPositions } from '../engines/positions.js';
import { buildCard } from '../engines/cards.js';
import { xpForCard } from '../engines/xp.js';
import { usdPerPairUnit } from './prices.js';
import { div, fromDecimalString, fromInt, mul, ratToString } from '../engines/money.js';

const SETTLE_JOB = 'settle';
const MAX_PAIRS_PER_RUN = 200;

/**
 * Exact price multiple from raw execution amounts:
 *   (pairOut/tokenOut)_sell ÷ (pairIn/tokenIn)_buy
 * For fixed-supply pump tokens this equals the mcap multiple exactly.
 * Returns { multiple_raw (string), multiple (double) } or null.
 */
function priceMultipleRaw(buys, sells) {
  if (!buys.length || !sells.length) return null;
  let inPair = 0n, inToken = 0n;
  for (const b of buys) {
    if (b.pair_amount_raw == null || b.token_amount_raw == null) return null;
    inPair += BigInt(b.pair_amount_raw);
    inToken += BigInt(b.token_amount_raw);
  }
  let outPair = 0n, outToken = 0n;
  for (const s of sells) {
    if (s.pair_amount_raw == null || s.token_amount_raw == null) return null;
    outPair += BigInt(s.pair_amount_raw);
    outToken += BigInt(s.token_amount_raw);
  }
  if (inPair <= 0n || inToken <= 0n || outPair <= 0n || outToken <= 0n) return null;
  // (outPair/outToken) / (inPair/inToken) = (outPair*inToken)/(outToken*inPair)
  const mult = div(mul(fromInt(outPair), fromInt(inToken)), mul(fromInt(outToken), fromInt(inPair)));
  return { multiple_raw: ratToString(mult), multiple: Number(mult.n) / Number(mult.d) };
}

/**
 * Double → plain decimal string (no exponents), safe for fromDecimalString.
 */
function plainDecimal(x) {
  if (!Number.isFinite(x)) throw new RangeError('non-finite price');
  let s = String(x);
  if (!/[eE]/.test(s)) return s;
  const [mant, exp] = s.split(/[eE]/);
  const e = parseInt(exp, 10);
  const neg = mant.startsWith('-');
  const digits = mant.replace('-', '').replace('.', '');
  const dotAt = mant.replace('-', '').indexOf('.');
  const intDigits = dotAt === -1 ? digits.length : dotAt;
  const newDot = intDigits + e;
  let out;
  if (newDot <= 0) out = '0.' + '0'.repeat(-newDot) + digits;
  else if (newDot >= digits.length) out = digits + '0'.repeat(newDot - digits.length);
  else out = digits.slice(0, newDot) + '.' + digits.slice(newDot);
  return (neg ? '-' : '') + out;
}

async function getWatermark(pool) {
  const { rows } = await pool.query(
    "SELECT updated_at FROM indexer_checkpoints WHERE job_name = $1",
    [SETTLE_JOB]
  );
  return rows.length ? new Date(rows[0].updated_at) : new Date(0);
}

async function setWatermark(pool, at) {
  await pool.query(
    `INSERT INTO indexer_checkpoints (job_name, updated_at)
     VALUES ($1, $2)
     ON CONFLICT (job_name) DO UPDATE SET updated_at = EXCLUDED.updated_at`,
    [SETTLE_JOB, at.toISOString()]
  );
}

async function touchedPairs(pool, since) {
  const { rows } = await pool.query(
    `SELECT wallet, mint, MAX(indexed_at) AS touched_at
       FROM trades
      WHERE indexed_at > $1
      GROUP BY wallet, mint
      ORDER BY touched_at ASC
      LIMIT $2`,
    [since.toISOString(), MAX_PAIRS_PER_RUN]
  );
  return rows;
}

export async function settleOnce(pool) {
  const watermark = await getWatermark(pool);
  const pairs = await touchedPairs(pool, watermark);
  if (!pairs.length) return { pairs: 0, cards: 0, xp: 0 };

  let cardsMinted = 0;
  let xpAwarded = 0;
  let maxTouched = watermark;

  for (const { wallet, mint, touched_at } of pairs) {
    if (new Date(touched_at) > maxTouched) maxTouched = new Date(touched_at);
    try {
      const r = await settlePair(pool, wallet, mint);
      cardsMinted += r.cards;
      xpAwarded += r.xp;
    } catch (e) {
      console.error(`[settle] ${wallet.slice(0, 8)}…/${mint.slice(0, 8)}… failed:`, e.message);
    }
  }
  await setWatermark(pool, maxTouched);
  if (cardsMinted || xpAwarded) {
    console.log(`[settle] ${pairs.length} pairs settled, ${cardsMinted} cards, ${xpAwarded} xp awards`);
  }
  return { pairs: pairs.length, cards: cardsMinted, xp: xpAwarded };
}

async function settlePair(pool, wallet, mint) {
  const { rows: trades } = await pool.query(
    `SELECT wallet, mint, side, token_amount_raw, pair_amount_raw,
            token_decimals, pair_decimals, signature, block_time, usd_estimate
       FROM trades
      WHERE wallet = $1 AND mint = $2
      ORDER BY block_time ASC NULLS LAST, id ASC`,
    [wallet, mint]
  );
  if (!trades.length) return { cards: 0, xp: 0 };

  // Transfers: decoder does not currently write them; handle defensively.
  const { rows: xfers } = await pool.query(
    `SELECT mint, direction, amount FROM transfers WHERE wallet = $1 AND mint = $2`,
    [wallet, mint]
  );
  const tokenDec = trades[0].token_decimals ?? 6;
  const transfers = xfers.map((x) => ({
    mint: x.mint,
    direction: x.direction,
    amount_raw: String(Math.round(Number(x.amount) * 10 ** tokenDec)),
  }));

  // Current price (rational, pair-raw per token-raw) for unrealized PnL —
  // null when unknown; the engine then leaves unrealized null (honest).
  const prices = new Map();
  const { rows: tok } = await pool.query(
    'SELECT price, pair_asset FROM tokens WHERE mint = $1',
    [mint]
  );
  if (tok.length && tok[0].price != null) {
    const pairDec = trades[0].pair_decimals ?? 9;
    // price is human units (pair per token); scale to pair-raw per token-raw.
    const priceRat = div(
      mul(fromDecimalString(plainDecimal(tok[0].price)), fromInt(10n ** BigInt(pairDec))),
      fromInt(10n ** BigInt(tokenDec))
    );
    prices.set(mint, priceRat);
  }

  const [position] = rebuildPositions(trades, transfers, prices);
  const client = await pool.connect();
  let cards = 0;
  let xp = 0;
  try {
    await client.query('BEGIN');
    const { rows: pos } = await client.query(
      `INSERT INTO positions (wallet, mint, quantity, cost_basis, cost_basis_method,
                              cost_basis_uncertain, realized_pnl, status,
                              quantity_raw, cost_basis_raw, realized_pnl_raw,
                              unrealized_pnl_raw, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
       ON CONFLICT (wallet, mint) DO UPDATE SET
         quantity = EXCLUDED.quantity,
         cost_basis = EXCLUDED.cost_basis,
         cost_basis_method = EXCLUDED.cost_basis_method,
         cost_basis_uncertain = EXCLUDED.cost_basis_uncertain,
         realized_pnl = EXCLUDED.realized_pnl,
         status = EXCLUDED.status,
         quantity_raw = EXCLUDED.quantity_raw,
         cost_basis_raw = EXCLUDED.cost_basis_raw,
         realized_pnl_raw = EXCLUDED.realized_pnl_raw,
         unrealized_pnl_raw = EXCLUDED.unrealized_pnl_raw,
         updated_at = now()
       RETURNING id, status`,
      [
        position.wallet, position.mint, position.quantity, position.cost_basis,
        position.cost_basis_method, position.cost_basis_uncertain,
        position.realized_pnl, position.status,
        position.quantity_raw, position.cost_basis_raw,
        position.realized_pnl_raw, position.unrealized_pnl_raw,
      ]
    );
    const positionId = pos[0].id;

    if (pos[0].status === 'CLOSED') {
      const { rows: existing } = await client.query(
        'SELECT id FROM cards WHERE wallet = $1 AND mint = $2 AND position_id = $3',
        [wallet, mint, positionId]
      );
      if (!existing.length) {
        // USD per whole pair unit for the $10 qualifying-entry filter.
        const pairAsset = tok.length ? tok[0].pair_asset : 'SOL';
        let usdPerUnit = null;
        try {
          const u = await usdPerPairUnit(pool, pairAsset);
          usdPerUnit = u ? u.rat : null;
        } catch (e) {
          console.error('[settle] price lookup failed:', e.message);
        }
        const card = buildCard(
          { id: positionId, wallet, mint },
          trades,
          null,
          usdPerUnit ? { usdPerPairUnit: usdPerUnit } : {}
        );
        if (card) {
          // Exact multiple from raw execution prices (fixed supply ⇒ equals
          // the mcap multiple). The engine leaves it null when mcaps are
          // unknown; we fill it from verified trade amounts instead of
          // leaving XP permanently unreachable.
          const mult = priceMultipleRaw(
            trades.filter((t) => t.side === 'BUY'),
            trades.filter((t) => t.side === 'SELL')
          );
          const { rows: ins } = await client.query(
            `INSERT INTO cards (wallet, mint, position_id, entry_mcap, exit_mcap,
                                return_pct, multiple, hold_duration_s,
                                ath_after_entry, qualifying_entry_usd, trades,
                                calculation_version, verified,
                                return_pct_raw, multiple_raw, qualifying_entry_usd_raw)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16)
             ON CONFLICT (wallet, mint, position_id) DO NOTHING
             RETURNING id, multiple_raw, multiple`,
            [
              card.wallet, card.mint, card.position_id,
              card.entry_mcap, card.exit_mcap,
              card.return_pct, mult ? mult.multiple : card.multiple,
              card.hold_duration_s, card.ath_after_entry,
              card.qualifying_entry_usd, JSON.stringify(card.trades),
              card.calculation_version, true, // all inputs are verified on-chain trades
              card.return_pct_raw, mult ? mult.multiple_raw : card.multiple_raw,
              card.qualifying_entry_usd_raw,
            ]
          );
          if (ins.length) {
            cards = 1;
            // XP: only for registered users; unregistered wallets earn none.
            const { rows: urows } = await client.query(
              'SELECT user_id FROM wallets WHERE pubkey = $1 LIMIT 1',
              [wallet]
            );
            if (urows.length) {
              const award = xpForCard(
                { id: ins[0].id, multiple_raw: ins[0].multiple_raw, multiple: ins[0].multiple, mint },
                urows[0].user_id
              );
              if (award) {
                const { rowCount } = await client.query(
                  `INSERT INTO xp_events (event_id, user_id, amount, reason,
                                          token_mint, source_event, calculation_version)
                   VALUES ($1,$2,$3,$4,$5,$6,$7)
                   ON CONFLICT (event_id) DO NOTHING`,
                  [award.event_id, award.user_id, award.amount, award.reason,
                   award.token_mint, award.source_event, award.calculation_version]
                );
                xp = rowCount;
              }
            }
          }
        }
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return { cards, xp };
}
