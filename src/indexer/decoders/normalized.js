// src/indexer/decoders/normalized.js — the CANONICAL decoded shapes.
//
// Architecture contract:
//
//   Raw Transaction
//     → Provider Decoder (pumpBonding.js / pumpSwap.js — the ONLY place that
//       understands Pump instruction/event layouts)
//     → NormalizedTrade / NormalizedLaunch / NormalizedGraduation /
//       NormalizedFeeEvent (this file — provider-agnostic)
//     → Database
//     → PositionEngine → CardEngine / XPEngine / BinderEngine
//
// Downstream systems must NEVER parse Pump-specific bytes. If a new provider
// is added, it implements the same shapes here and nothing downstream changes.
//
// AMOUNT RULES (non-negotiable):
//   * Every amount is a BigInt in memory, a decimal STRING of the integer in
//     storage/JSON. Never a Number, never a float.
//   * *_raw fields are raw on-chain integer units (lamports for SOL,
//     raw token units for SPL tokens).
//   * *_decimals is the integer that converts raw → whole units, resolved
//     from the mint account or the AMM CreatePoolEvent. null = unknown.
//     UNKNOWN ≠ 0: a null decimal means "do not normalize", not "assume".
//   * Normalized (whole-unit) values are exact decimal STRINGS produced by
//     src/engines/money.js fromRawInt(), only at the display edge.

/**
 * NormalizedTrade — one verified economic trade.
 *
 * Identity:
 *   decoder_version  'pump-bonding-v1' | 'pumpswap-v1' (see layouts.js)
 *   provider         'pump' (always, for both decoders)
 *   signature        base58 transaction signature
 *   event_index      per-transaction event sequence (0,1,2,…) — with the
 *                    signature this is the idempotency key
 *   instruction_index        top-level instruction index the event belongs to
 *   inner_instruction_index  inner-instruction sequence within it (0 when top-level)
 *   slot, block_time (unix seconds), confirmation ('observed'|'confirmed'|'finalized')
 *
 * Parties & asset:
 *   wallet     trader (base58)
 *   mint       token mint (base58)
 *   side       'BUY' | 'SELL'
 *   creator    token creator (base58, null when unknown)
 *
 * Amounts (all BigInt in memory):
 *   token_amount_raw   raw token units the user received (BUY) or sold (SELL)
 *   token_decimals     null when unresolvable
 *   pair_asset         'SOL' or a quote mint (base58)
 *   pair_amount_raw    raw pair units the user SPENT (BUY) or RECEIVED (SELL),
 *                      net of program fees per the decoder's documented semantics
 *   pair_decimals      9 for SOL, resolved for token quotes, null when unknown
 *
 * Fees (BigInt, null when the event layout predates the field):
 *   fee_protocol_raw, fee_creator_raw, fee_lp_raw,
 *   fee_cashback_raw, fee_buyback_raw, fee_holder_rewards_raw
 *   fee_recipient      base58, null when unknown
 *
 * Market context (BigInt, null when unavailable):
 *   reserve fields as provided by the event (curve reserves / pool reserves)
 *
 * Provenance:
 *   ix_name        program's own instruction label (e.g. 'buy', 'sell_v2')
 *   event_name     'TradeEvent' | 'BuyEvent' | 'SellEvent'
 *   raw            the decoded event's raw fields (BigInts as strings) for audit
 */
export function makeNormalizedTrade(t) {
  const req = [
    'decoder_version', 'signature', 'event_index', 'wallet', 'mint', 'side',
    'token_amount_raw', 'pair_amount_raw',
  ];
  for (const k of req) {
    if (t[k] === undefined || t[k] === null) {
      throw new Error(`NormalizedTrade missing required field: ${k}`);
    }
  }
  if (t.side !== 'BUY' && t.side !== 'SELL') {
    throw new Error(`NormalizedTrade invalid side: ${t.side}`);
  }
  return {
    decoder_version: t.decoder_version,
    provider: 'pump',
    program: t.program ?? null,
    signature: t.signature,
    event_index: t.event_index,
    instruction_index: t.instruction_index ?? null,
    inner_instruction_index: t.inner_instruction_index ?? null,
    slot: t.slot ?? null,
    block_time: t.block_time ?? null,
    confirmation: t.confirmation ?? 'confirmed',
    wallet: t.wallet,
    mint: t.mint,
    side: t.side,
    creator: t.creator ?? null,
    token_amount_raw: BigInt(t.token_amount_raw),
    token_decimals: t.token_decimals ?? null,
    pair_asset: t.pair_asset ?? 'SOL',
    // Quote mint for token-quoted trades (e.g. WSOL for PumpSwap). Native-SOL
    // quotes carry null. Used by the balance reconciler to attribute
    // wrap/unwrap flows; the pair_asset label is unchanged.
    quote_mint: t.quote_mint ?? null,
    pair_amount_raw: BigInt(t.pair_amount_raw),
    pair_decimals: t.pair_decimals ?? null,
    fee_protocol_raw: t.fee_protocol_raw == null ? null : BigInt(t.fee_protocol_raw),
    fee_creator_raw: t.fee_creator_raw == null ? null : BigInt(t.fee_creator_raw),
    fee_lp_raw: t.fee_lp_raw == null ? null : BigInt(t.fee_lp_raw),
    fee_cashback_raw: t.fee_cashback_raw == null ? null : BigInt(t.fee_cashback_raw),
    fee_buyback_raw: t.fee_buyback_raw == null ? null : BigInt(t.fee_buyback_raw),
    fee_holder_rewards_raw:
      t.fee_holder_rewards_raw == null ? null : BigInt(t.fee_holder_rewards_raw),
    fee_recipient: t.fee_recipient ?? null,
    reserves: t.reserves ?? null,
    ix_name: t.ix_name ?? null,
    event_name: t.event_name ?? null,
    raw: t.raw ?? null,
  };
}

/** Serialize a NormalizedTrade for storage/JSON (BigInts → decimal strings). */
export function serializeTrade(t) {
  const big = (v) => (v === null || v === undefined ? null : v.toString());
  return {
    ...t,
    token_amount_raw: t.token_amount_raw.toString(),
    pair_amount_raw: t.pair_amount_raw.toString(),
    fee_protocol_raw: big(t.fee_protocol_raw),
    fee_creator_raw: big(t.fee_creator_raw),
    fee_lp_raw: big(t.fee_lp_raw),
    fee_cashback_raw: big(t.fee_cashback_raw),
    fee_buyback_raw: big(t.fee_buyback_raw),
    fee_holder_rewards_raw: big(t.fee_holder_rewards_raw),
    raw: t.raw ? JSON.parse(JSON.stringify(t.raw, (_, v) => (typeof v === 'bigint' ? v.toString() : v))) : null,
  };
}

/**
 * NormalizedLaunch — a verified token creation.
 * launch_origin is ALWAYS 'EXTERNAL_PUMP' here; the indexer upgrades it to
 * 'LAUNCHFOLIO' only when a launch_records row exists for the mint. The
 * decoder never infers Launchfolio origin.
 */
export function makeNormalizedLaunch(l) {
  for (const k of ['decoder_version', 'signature', 'event_index', 'mint', 'creator']) {
    if (l[k] === undefined || l[k] === null) {
      throw new Error(`NormalizedLaunch missing required field: ${k}`);
    }
  }
  return {
    decoder_version: l.decoder_version,
    provider: 'pump',
    signature: l.signature,
    event_index: l.event_index,
    instruction_index: l.instruction_index ?? null,
    slot: l.slot ?? null,
    block_time: l.block_time ?? null,
    confirmation: l.confirmation ?? 'confirmed',
    mint: l.mint,
    creator: l.creator,
    launcher_wallet: l.launcher_wallet ?? l.creator,
    name: l.name ?? null,
    ticker: l.ticker ?? null,
    metadata_uri: l.metadata_uri ?? null,
    bonding_curve: l.bonding_curve ?? null,
    token_program: l.token_program ?? null,
    pair_asset: l.pair_asset ?? 'SOL',
    launch_origin: 'EXTERNAL_PUMP', // upgraded only via launch_records
    raw: l.raw ?? null,
  };
}

/**
 * NormalizedGraduation — a verified BONDING → GRADUATED lifecycle transition.
 * The token record is UPDATED, never duplicated.
 */
export function makeNormalizedGraduation(g) {
  for (const k of ['decoder_version', 'signature', 'event_index', 'mint']) {
    if (g[k] === undefined || g[k] === null) {
      throw new Error(`NormalizedGraduation missing required field: ${k}`);
    }
  }
  return {
    decoder_version: g.decoder_version,
    provider: 'pump',
    signature: g.signature,
    event_index: g.event_index,
    slot: g.slot ?? null,
    block_time: g.block_time ?? null,
    confirmation: g.confirmation ?? 'confirmed',
    mint: g.mint,
    pool: g.pool ?? null,
    raw: g.raw ?? null,
  };
}

/**
 * NormalizedFeeEvent — verified fee accounting. No payout logic lives here.
 * fee_type: 'protocol_fee' | 'creator_fee' | 'lp_fee' | 'cashback' |
 *           'buyback_fee' | 'holder_rewards' | 'network_fee' | 'creator_fee_claim'
 * attribution: 'event' (decoded from the program event — exact) |
 *              'unresolved' (observed but not attributable — never guessed)
 */
export function makeNormalizedFeeEvent(f) {
  for (const k of ['decoder_version', 'signature', 'fee_type', 'amount_raw']) {
    if (f[k] === undefined || f[k] === null) {
      throw new Error(`NormalizedFeeEvent missing required field: ${k}`);
    }
  }
  return {
    decoder_version: f.decoder_version,
    provider: 'pump',
    signature: f.signature,
    event_index: f.event_index ?? 0,
    slot: f.slot ?? null,
    block_time: f.block_time ?? null,
    mint: f.mint ?? null,
    fee_type: f.fee_type,
    amount_raw: BigInt(f.amount_raw),
    amount_decimals: f.amount_decimals ?? 9,
    recipient: f.recipient ?? null,
    attribution: f.attribution ?? 'event',
    trade_signature: f.trade_signature ?? f.signature,
    raw: f.raw ?? null,
  };
}
