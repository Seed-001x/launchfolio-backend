// src/engines/xp.js — XPEngine
//
// METHODOLOGY:
//   * XP derives ONLY from qualifying card/position close events that came
//     from verified on-chain activity. Demo/mock activity never mints XP here.
//   * Every award is an append-only row in xp_events with a DETERMINISTIC
//     event_id = sha256(source_type + ':' + source_ref + ':' + reason), so
//     re-ingestion is a no-op (INSERT ... ON CONFLICT DO NOTHING).
//   * Every award carries: reason, amount, user, token, source_event,
//     timestamp, calculation_version. No exceptions.
//
// XP TIERS (Launchfolio-controlled; matches the product's performance tiers):
//   multiple >= 10  -> 500 XP   (ten bagger)
//   multiple >= 5   -> 250 XP   (five bagger)
//   multiple >= 2   -> 100 XP   (first double)
//   multiple >= 1   -> 25 XP    (profitable close)
//   multiple < 1    -> 10 XP    (completed trade — participation, not profit)
//
// Pure functions; the caller persists rows into xp_events.

import { createHash } from 'node:crypto';
import { ratFromString, fromDecimalString, fromInt, cmp } from './money.js';

export const CALCULATION_VERSION = 'xp/v2';

export const XP_TIERS = [
  { minMultiple: 10, xp: 500, reason: 'ten_bagger' },
  { minMultiple: 5, xp: 250, reason: 'five_bagger' },
  { minMultiple: 2, xp: 100, reason: 'first_double' },
  { minMultiple: 1, xp: 25, reason: 'profitable_close' },
  { minMultiple: -Infinity, xp: 10, reason: 'completed_trade' },
];

/** Deterministic event id: re-running the pipeline never double-awards. */
export function xpEventId(sourceType, sourceRef, reason) {
  return createHash('sha256')
    .update(`${sourceType}:${sourceRef}:${reason}`)
    .digest('hex');
}

/**
 * Derive the XP award for a closed-position card.
 *
 * Tier comparison uses the card's EXACT multiple (multiple_raw, an exact
 * "n/d" rational string) when present, so a 1.9999999999 float artifact can
 * never demote a true 2x into the wrong tier. Falls back to the legacy
 * double multiple. Tiers themselves are unchanged.
 *
 * @param {Object} card - card row from CardEngine (needs .multiple or .multiple_raw, .id).
 * @param {string} userId - Launchfolio user id.
 * @returns {Object|null} xp_events row, or null when the card has no
 *                        computable multiple (we never guess).
 */
export function xpForCard(card, userId) {
  let multipleRat = null;
  if (card.multiple_raw) {
    try {
      multipleRat = ratFromString(card.multiple_raw);
    } catch {
      multipleRat = null;
    }
  } else if (card.multiple !== null && card.multiple !== undefined) {
    multipleRat = fromDecimalString(String(card.multiple));
  }
  if (multipleRat === null) return null; // no computable multiple — never guess

  let tier = null;
  for (const t of XP_TIERS) {
    if (t.minMultiple === -Infinity || cmp(multipleRat, fromInt(t.minMultiple)) >= 0) {
      tier = t;
      break;
    }
  }
  if (!tier) return null;
  return {
    event_id: xpEventId('card', card.id, tier.reason),
    user_id: userId,
    amount: tier.xp,
    reason: tier.reason,
    token_mint: card.mint,
    source_event: card.id,
    calculation_version: CALCULATION_VERSION,
    created_at: new Date().toISOString(),
  };
}
