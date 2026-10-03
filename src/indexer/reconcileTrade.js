// src/indexer/reconcileTrade.js — per-trade balance reconciliation.
//
// Verifies each decoded trade's amounts against the transaction's ACTUAL
// on-chain movements (preBalances/postBalances and
// preTokenBalances/postTokenBalances). This is an independent tripwire over
// the decoder: the program EVENT remains authoritative for what happened
// economically, but any divergence between the event and the trader's real
// balance movements is flagged for investigation.
//
// Authority model (read carefully):
//   - The decoded event is authoritative. A mismatch NEVER blocks, deletes,
//     or alters the stored trade.
//   - A mismatch queues a decode_failures row (stage 'reconcile:trade') with
//     the expected-vs-observed detail and the raw tx meta preserved.
//   - 'unavailable' / 'skipped' are NOT mismatches: they mean the check could
//     not be run honestly (missing data, or economics the decoder cannot see).
//     Unknown is reported as unknown, never coerced to a pass.
//
// Checks:
//   1. base-token check — the trader's summed token-account delta for the
//      trade's mint must EXACTLY equal +token_amount_raw (BUY) or
//      -token_amount_raw (SELL). Tolerance is zero: token transfers are
//      exact. Verified against a real aggregator-routed mainnet buy, where
//      the trader's token delta matched the decoded amount to the unit.
//   2. quote-side check — the trader's combined SOL + quote-token flow must
//      equal the decoded pair amount (sign by side), minus the network fee
//      when the trader paid it, minus ATA rent for token accounts created in
//      the tx. For WSOL-quoted (PumpSwap) trades the SOL and WSOL deltas are
//      summed because wrapping/unwrapping is 1:1 and exact; pre-existing
//      WSOL that gets unwrapped in the same tx cancels out of the sum.
//      Aggregator-routed trades (pump invoked via CPI, inner_instruction_index
//      > 0) SKIP this check: router-level economics (aggregator fees,
//      intermediate hops, extra rent) are invisible to the decoder, and the
//      real mainnet fixture proves the divergence is real
//      (1,517,105,000 lamports moved vs 1,481,481,480 decoded).
//
// Tolerances (documented, not fudge factors):
//   - Token side: 0. Any unit-level divergence is economically meaningful.
//   - SOL side: DUST_LAMPORTS = 1,000 lamports (~$0.0002). Covers lamport-level
//     dust from account operations the model does not itemize. Anything above
//     it is real economic disagreement and gets flagged.
//   - Rent: ATA_RENT_LAMPORTS = 2,039,280 (rent-exempt minimum for a token
//     account). Applied per token account newly appearing for the trader in
//     postTokenBalances; a second SELL hypothesis adds one rent unit back for
//     a possible ATA/WSOL-account close in the same tx.
//
// Known blind spots (documented, not hidden):
//   - Multi-trade transactions: each trade is checked independently against
//     the trader's TOTAL tx-level movements, so a tx with two swaps will
//     flag both trades. Correct tripwire behavior — needs analyst review.
//   - Priority-fee-only differences are inside meta.fee and handled; tips to
//     Jito-style relayers outside the tx are invisible (same class as
//     aggregator fees).

import { getAllAccountKeys } from './decoders/walkLogs.js';
import { WSOL_MINT } from './decoders/layouts.js';

/** Rent-exempt minimum for a token account (lamports). */
export const ATA_RENT_LAMPORTS = 2_039_280;
/**
 * SOL-side tripwire threshold (lamports). Divergences at or below this are
 * treated as dust; anything above is flagged. Deliberately small: it is a
 * tripwire, not a fudge factor.
 */
export const DUST_LAMPORTS = 1_000;

function big(n) {
  return BigInt(String(n ?? '0'));
}

function abs(x) {
  return x < 0n ? -x : x;
}

/**
 * Sum the trader's token-balance delta for one mint across all of their
 * token accounts. A pre-only account is treated as closed (post = 0);
 * a post-only account is treated as created (pre = 0).
 * Returns { delta, preOnly, postOnly } where preOnly/postOnly count the
 * trader's accounts appearing on one side only.
 */
function tokenDelta(preTB, postTB, owner, mint) {
  const pre = new Map();
  const post = new Map();
  for (const b of preTB ?? []) {
    if (b.owner === owner && b.mint === mint) pre.set(b.accountIndex, big(b.uiTokenAmount?.amount));
  }
  for (const b of postTB ?? []) {
    if (b.owner === owner && b.mint === mint) post.set(b.accountIndex, big(b.uiTokenAmount?.amount));
  }
  let delta = 0n;
  let preOnly = 0;
  let postOnly = 0;
  for (const [i, amt] of pre) {
    if (post.has(i)) delta += post.get(i) - amt;
    else { delta += 0n - amt; preOnly++; }
  }
  for (const [i, amt] of post) {
    if (!pre.has(i)) { delta += amt; postOnly++; }
  }
  return { delta, preOnly, postOnly, found: pre.size > 0 || post.size > 0 };
}

/**
 * Reconcile one decoded trade against its transaction's balance data.
 *
 * @param {object} trade NormalizedTrade-ish: { signature, wallet, mint, side,
 *   token_amount_raw, pair_amount_raw, pair_asset, quote_mint,
 *   inner_instruction_index }
 * @param {object} tx Raw getTransaction JSON.
 * @returns {object} { checks: { token, quote }, mismatch, summary }
 *   Each check: { status: 'ok'|'mismatch'|'skipped'|'unavailable',
 *     expected: string[]|null, observed: string|null,
 *     hypothesis: string|null, reason: string|null }
 */
export function reconcileTradeAmounts(trade, tx) {
  const checks = {
    token: { status: 'unavailable', expected: null, observed: null, hypothesis: null, reason: null },
    quote: { status: 'unavailable', expected: null, observed: null, hypothesis: null, reason: null },
  };
  const meta = tx?.meta;
  const fail = (check, reason) => {
    checks[check].status = 'unavailable';
    checks[check].reason = reason;
  };

  if (!meta || !Array.isArray(meta.preBalances) || !Array.isArray(meta.postBalances)) {
    fail('token', 'tx missing preBalances/postBalances');
    fail('quote', 'tx missing preBalances/postBalances');
    return finish(checks, trade, 'balance data missing');
  }

  let keys;
  try {
    keys = getAllAccountKeys(tx);
  } catch (err) {
    fail('token', `account keys unresolvable: ${err.message}`);
    fail('quote', `account keys unresolvable: ${err.message}`);
    return finish(checks, trade, 'account keys unresolvable');
  }
  const traderIdx = keys.indexOf(trade.wallet);
  if (traderIdx < 0 || traderIdx >= meta.preBalances.length) {
    fail('token', 'trader wallet not in tx account keys');
    fail('quote', 'trader wallet not in tx account keys');
    return finish(checks, trade, 'trader not in tx');
  }

  const preTB = meta.preTokenBalances;
  const postTB = meta.postTokenBalances;
  if (!Array.isArray(preTB) || !Array.isArray(postTB)) {
    // Rent adjustments are unknowable without token-balance data; fail closed.
    fail('token', 'tx missing preTokenBalances/postTokenBalances');
    fail('quote', 'tx missing preTokenBalances/postTokenBalances');
    return finish(checks, trade, 'token-balance data missing');
  }

  // ---- 1. base-token check (exact, tolerance 0) ----
  const tokenRaw = big(trade.token_amount_raw);
  const expectedTokenDelta = trade.side === 'BUY' ? tokenRaw : -tokenRaw;
  const tok = tokenDelta(preTB, postTB, trade.wallet, trade.mint);
  checks.token.expected = [expectedTokenDelta.toString()];
  if (!tok.found) {
    fail('token', 'no token-balance entries for trader+mint');
  } else {
    checks.token.observed = tok.delta.toString();
    checks.token.hypothesis = 'exact match required';
    if (tok.delta === expectedTokenDelta) {
      checks.token.status = 'ok';
    } else {
      checks.token.status = 'mismatch';
      checks.token.reason =
        `trader token delta ${tok.delta} != decoded ${trade.side === 'BUY' ? '+' : '-'}${tokenRaw}`;
    }
  }

  // ---- 2. quote-side check (combined SOL + quote-token flow) ----
  const routed = (trade.inner_instruction_index ?? 0) > 0;
  if (routed) {
    checks.quote.status = 'skipped';
    checks.quote.reason =
      'aggregator-routed (pump invoked via CPI): router-level economics (aggregator fees, ' +
      'intermediate hops) are invisible to the decoder; SOL-side check cannot be run honestly';
  } else {
    const pairRaw = big(trade.pair_amount_raw);
    const feePayer = keys[0];
    const feePaid = feePayer === trade.wallet ? big(meta.fee) : 0n;

    // Rent for token accounts newly created for the trader in this tx.
    const preIdx = new Set(preTB.filter((b) => b.owner === trade.wallet).map((b) => b.accountIndex));
    let newAccounts = 0;
    for (const b of postTB) {
      if (b.owner === trade.wallet && !preIdx.has(b.accountIndex)) newAccounts++;
    }
    const rentNew = BigInt(newAccounts) * BigInt(ATA_RENT_LAMPORTS);

    const solDelta = big(meta.postBalances[traderIdx]) - big(meta.preBalances[traderIdx]);

    // Quote-token flow. For token-quoted trades (WSOL on PumpSwap) the SOL and
    // quote-token deltas are summed: wrapping/unwrapping is 1:1 and exact, so
    // pre-existing quote tokens unwrapped in the same tx cancel out of the
    // sum. The quote mint arrives on the trade (quote_mint); the pair_asset
    // label is untouched.
    let quoteTokenDelta = 0n;
    let quoteMint = null;
    if (trade.quote_mint === WSOL_MINT) quoteMint = WSOL_MINT;
    else if (trade.quote_mint != null) {
      checks.quote.status = 'skipped';
      checks.quote.reason = `unsupported quote mint for quote check: ${trade.quote_mint}`;
    }
    if (quoteMint) {
      const q = tokenDelta(preTB, postTB, trade.wallet, quoteMint);
      quoteTokenDelta = q.delta;
      // Note: no separate exact quote check — in-tx wrapping/unwrapping makes
      // the standalone quote delta ambiguous; the combined flow below is exact.
    }

    if (checks.quote.status !== 'skipped') {
      const combined = solDelta + quoteTokenDelta;
      checks.quote.observed = combined.toString();
      const dir = trade.side === 'BUY' ? -1n : 1n;
      const base = dir * pairRaw - feePaid - rentNew;
      // Hypotheses: base case, plus one rent unit returned via an in-tx
      // account close (ATA on sells, temp WSOL account on buys).
      const candidates = [base, base + BigInt(ATA_RENT_LAMPORTS)];
      checks.quote.expected = candidates.map((c) => c.toString());
      const hit = candidates.findIndex((c) => abs(combined - c) <= BigInt(DUST_LAMPORTS));
      if (hit >= 0) {
        checks.quote.status = 'ok';
        checks.quote.hypothesis =
          hit === 0 ? 'direct flow (pair +/- fee + new-account rent)' : 'with one in-tx account-close rent return';
        checks.quote.reason =
          `trader=${trade.wallet.slice(0, 8)}… solΔ=${solDelta}` +
          (quoteMint ? ` wsolΔ=${quoteTokenDelta}` : '') +
          ` fee=${feePaid} newAccounts=${newAccounts}`;
      } else {
        checks.quote.status = 'mismatch';
        checks.quote.hypothesis = 'direct flow or single account-close rent return';
        checks.quote.reason =
          `combined trader flow ${combined} matches neither ${candidates[0]} nor ${candidates[1]} ` +
          `(dust tolerance ${DUST_LAMPORTS}; fee=${feePaid} newAccounts=${newAccounts})`;
      }
    }
  }

  return finish(checks, trade, null);
}

function finish(checks, trade, note) {
  const mismatch = Object.values(checks).some((c) => c.status === 'mismatch');
  const parts = [`${trade.side} ${trade.signature.slice(0, 12)}…`];
  for (const [name, c] of Object.entries(checks)) {
    parts.push(`${name}=${c.status}${c.reason ? ` (${c.reason})` : ''}`);
  }
  if (note) parts.push(note);
  return { checks, mismatch, summary: parts.join('; ') };
}
