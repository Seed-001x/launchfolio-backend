// src/indexer/decoders/layouts.js — VERIFIED Pump program definitions.
//
// SOURCE: @pump-fun/pump-sdk v2.0.0 (public npm SDK, NOT the pump.fun
// frontend). Program IDs cross-checked against the SDK's exported constants
// (src/sdk.ts: PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID, PUMP_FEE_PROGRAM_ID).
// Event discriminators + field layouts are verbatim from the vendored IDL
// JSON (src/idl/pump.json, src/idl/pump_amm.json), field order preserved
// (Borsh is order-sensitive). The TradeEvent layout was additionally verified
// byte-for-byte against a real mainnet buy transaction (see test/fixtures/).
//
// DECODER VERSIONS:
//   pump-bonding-v1 — Pump bonding-curve program events (this file's TRADE_EVENT_* etc.)
//   pumpswap-v1     — PumpSwap AMM program events (BUY_EVENT_AMM / SELL_EVENT_AMM / ...)
// Financial decoding logic must never change without bumping the version
// stored on every decoded row (trades.decoder_version, fee_events.decoder_version).

export const PROGRAM_IDS = {
  /** Pump bonding-curve program (launches + bonding-curve trades). */
  PUMP: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  /** PumpSwap AMM program (post-graduation trades). */
  PUMP_AMM: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
  /** Pump fees program (fee schedule / claims infra; not decoded for trades). */
  PUMP_FEES: 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ',
};

export const DECODER_VERSIONS = {
  PUMP_BONDING: 'pump-bonding-v1',
  PUMP_SWAP: 'pumpswap-v1',
};

// ---------------------------------------------------------------------------
// Pump bonding-curve program — Anchor event discriminators (8 bytes each).
// Anchor events are logged as `Program data: <base64>`; the first 8 bytes
// select the event, the rest is Borsh per the field layouts below.
// ---------------------------------------------------------------------------

export const PUMP_EVENT_DISCRIMINATORS = {
  TradeEvent: [189, 219, 127, 211, 78, 230, 97, 238],
  CreateEvent: [27, 114, 169, 77, 222, 235, 99, 118],
  CompleteEvent: [95, 114, 97, 156, 212, 46, 152, 8],
  CompletePumpAmmMigrationEvent: [189, 233, 93, 185, 92, 148, 234, 148],
  CollectCreatorFeeEvent: [122, 2, 127, 1, 14, 191, 12, 175],
  DistributeCreatorFeesEvent: [165, 55, 129, 112, 4, 179, 202, 40],
  SetCreatorEvent: [237, 52, 123, 37, 245, 251, 72, 210],
};

/**
 * TradeEvent — emitted by buy / sell / buy_v2 / sell_v2 / buy_exact_*.
 * FEE SEMANTICS (verified from the SDK's bonding-curve math,
 * src/bondingCurve.ts getBuyTokenAmountFromSolAmount / getSellSolAmountFromTokenAmount):
 *   * BUY:  the user pays `sol_amount` lamports IN TOTAL (fees are taken OUT
 *           of it by the program). Cost basis for the buyer = sol_amount.
 *   * SELL: the user RECEIVES `sol_amount` lamports NET (fees already
 *           deducted by the program). Proceeds for the seller = sol_amount.
 *   * `fee` / `creator_fee` / `cashback` / `buyback_fee` / `holder_rewards`
 *     are the exact deducted portions, for fee accounting (never inferred).
 * LAYOUT VARIANTS: events emitted before holder-reward fields existed are
 * 16 bytes shorter (missing holder_rewards_bps + holder_rewards, both u64).
 * The decoder zero-pads them, exactly like the SDK's decodeTradeEventBc.
 */
export const TRADE_EVENT_LAYOUT = [
  ['mint', 'pubkey'],
  ['sol_amount', 'u64'],
  ['token_amount', 'u64'],
  ['is_buy', 'bool'],
  ['user', 'pubkey'],
  ['timestamp', 'i64'],
  ['virtual_sol_reserves', 'u64'],
  ['virtual_token_reserves', 'u64'],
  ['real_sol_reserves', 'u64'],
  ['real_token_reserves', 'u64'],
  ['fee_recipient', 'pubkey'],
  ['fee_basis_points', 'u64'],
  ['fee', 'u64'],
  ['creator', 'pubkey'],
  ['creator_fee_basis_points', 'u64'],
  ['creator_fee', 'u64'],
  ['track_volume', 'bool'],
  ['total_unclaimed_tokens', 'u64'],
  ['total_claimed_tokens', 'u64'],
  ['current_sol_volume', 'u64'],
  ['last_update_timestamp', 'i64'],
  ['ix_name', 'string'],
  ['mayhem_mode', 'bool'],
  ['cashback_fee_basis_points', 'u64'],
  ['cashback', 'u64'],
  ['buyback_fee_basis_points', 'u64'],
  ['buyback_fee', 'u64'],
  ['shareholders', ['vec', ['struct', [['address', 'pubkey'], ['share_bps', 'u16']]]]],
  ['quote_mint', 'pubkey'],
  ['quote_amount', 'u64'],
  ['virtual_quote_reserves', 'u64'],
  ['real_quote_reserves', 'u64'],
  // --- fields added later; absent (16 zero bytes) in older events ---
  ['holder_rewards_bps', 'u64'],
  ['holder_rewards', 'u64'],
];
export const TRADE_EVENT_TRAILING_DEFAULT_BYTES = 16;

/** CreateEvent — emitted by create / create_v2. The launch signal. */
export const CREATE_EVENT_LAYOUT = [
  ['name', 'string'],
  ['symbol', 'string'],
  ['uri', 'string'],
  ['mint', 'pubkey'],
  ['bonding_curve', 'pubkey'],
  ['user', 'pubkey'],
  ['creator', 'pubkey'],
  ['timestamp', 'i64'],
  ['virtual_token_reserves', 'u64'],
  ['virtual_sol_reserves', 'u64'],
  ['real_token_reserves', 'u64'],
  ['token_total_supply', 'u64'],
  ['token_program', 'pubkey'],
  ['is_mayhem_mode', 'bool'],
  ['is_cashback_enabled', 'bool'],
  ['quote_mint', 'pubkey'],
  ['virtual_quote_reserves', 'u64'],
  ['creator_fee_bps', 'u64'],
  ['is_holder_reward', 'bool'],
];

/** CompleteEvent — legacy bonding-curve completion (graduation) signal. */
export const COMPLETE_EVENT_LAYOUT = [
  ['user', 'pubkey'],
  ['mint', 'pubkey'],
  ['bonding_curve', 'pubkey'],
  ['timestamp', 'i64'],
  ['quote_mint', 'pubkey'],
];

/**
 * CompletePumpAmmMigrationEvent — the definitive graduation signal: the
 * bonding curve migrated to a PumpSwap pool. `pool` is the new AMM pool.
 */
export const COMPLETE_PUMP_AMM_MIGRATION_EVENT_LAYOUT = [
  ['user', 'pubkey'],
  ['mint', 'pubkey'],
  ['mint_amount', 'u64'],
  ['sol_amount', 'u64'],
  ['pool_migration_fee', 'u64'],
  ['bonding_curve', 'pubkey'],
  ['timestamp', 'i64'],
  ['pool', 'pubkey'],
  ['quote_mint', 'pubkey'],
];

/** CollectCreatorFeeEvent — creator claims accumulated fees (fee accounting). */
export const COLLECT_CREATOR_FEE_EVENT_LAYOUT = [
  ['timestamp', 'i64'],
  ['creator', 'pubkey'],
  ['creator_fee', 'u64'],
  ['quote_mint', 'pubkey'],
];

// ---------------------------------------------------------------------------
// PumpSwap AMM program — Anchor event discriminators.
// ---------------------------------------------------------------------------

export const PUMP_AMM_EVENT_DISCRIMINATORS = {
  BuyEvent: [103, 244, 82, 31, 44, 245, 119, 119],
  SellEvent: [62, 47, 55, 10, 165, 3, 220, 42],
  CreatePoolEvent: [177, 49, 12, 210, 160, 118, 167, 116],
  CollectCoinCreatorFeeEvent: [232, 245, 194, 238, 234, 218, 58, 89],
};

/**
 * BuyEvent (AMM) — post-graduation buy.
 * The user pays `user_quote_amount_in` and receives `base_amount_out`.
 * Fee fields (lp_fee, protocol_fee, coin_creator_fee, cashback, buyback_fee,
 * holder_rewards) are exact deducted portions for accounting.
 * Same trailing-defaults rule as the bonding-curve TradeEvent: older events
 * lack the final 16 bytes (holder_rewards_bps + holder_rewards).
 */
export const AMM_BUY_EVENT_LAYOUT = [
  ['timestamp', 'i64'],
  ['base_amount_out', 'u64'],
  ['max_quote_amount_in', 'u64'],
  ['user_base_token_reserves', 'u64'],
  ['user_quote_token_reserves', 'u64'],
  ['pool_base_token_reserves', 'u64'],
  ['pool_quote_token_reserves', 'u64'],
  ['quote_amount_in', 'u64'],
  ['lp_fee_basis_points', 'u64'],
  ['lp_fee', 'u64'],
  ['protocol_fee_basis_points', 'u64'],
  ['protocol_fee', 'u64'],
  ['quote_amount_in_with_lp_fee', 'u64'],
  ['user_quote_amount_in', 'u64'],
  ['pool', 'pubkey'],
  ['user', 'pubkey'],
  ['user_base_token_account', 'pubkey'],
  ['user_quote_token_account', 'pubkey'],
  ['protocol_fee_recipient', 'pubkey'],
  ['protocol_fee_recipient_token_account', 'pubkey'],
  ['coin_creator', 'pubkey'],
  ['coin_creator_fee_basis_points', 'u64'],
  ['coin_creator_fee', 'u64'],
  ['track_volume', 'bool'],
  ['total_unclaimed_tokens', 'u64'],
  ['total_claimed_tokens', 'u64'],
  ['current_sol_volume', 'u64'],
  ['last_update_timestamp', 'i64'],
  ['min_base_amount_out', 'u64'],
  ['ix_name', 'string'],
  ['cashback_fee_basis_points', 'u64'],
  ['cashback', 'u64'],
  ['buyback_fee_basis_points', 'u64'],
  ['buyback_fee', 'u64'],
  ['virtual_quote_reserves', 'i128'],
  ['can_boost', 'bool'],
  ['base_supply', 'u64'],
  ['holder_rewards_bps', 'u64'],
  ['holder_rewards', 'u64'],
];
export const AMM_EVENT_TRAILING_DEFAULT_BYTES = 16;

/**
 * SellEvent (AMM) — post-graduation sell.
 * The user sells `base_amount_in` and receives `user_quote_amount_out` net.
 */
export const AMM_SELL_EVENT_LAYOUT = [
  ['timestamp', 'i64'],
  ['base_amount_in', 'u64'],
  ['min_quote_amount_out', 'u64'],
  ['user_base_token_reserves', 'u64'],
  ['user_quote_token_reserves', 'u64'],
  ['pool_base_token_reserves', 'u64'],
  ['pool_quote_token_reserves', 'u64'],
  ['quote_amount_out', 'u64'],
  ['lp_fee_basis_points', 'u64'],
  ['lp_fee', 'u64'],
  ['protocol_fee_basis_points', 'u64'],
  ['protocol_fee', 'u64'],
  ['quote_amount_out_without_lp_fee', 'u64'],
  ['user_quote_amount_out', 'u64'],
  ['pool', 'pubkey'],
  ['user', 'pubkey'],
  ['user_base_token_account', 'pubkey'],
  ['user_quote_token_account', 'pubkey'],
  ['protocol_fee_recipient', 'pubkey'],
  ['protocol_fee_recipient_token_account', 'pubkey'],
  ['coin_creator', 'pubkey'],
  ['coin_creator_fee_basis_points', 'u64'],
  ['coin_creator_fee', 'u64'],
  ['cashback_fee_basis_points', 'u64'],
  ['cashback', 'u64'],
  ['buyback_fee_basis_points', 'u64'],
  ['buyback_fee', 'u64'],
  ['virtual_quote_reserves', 'i128'],
  ['can_boost', 'bool'],
  ['base_supply', 'u64'],
  ['holder_rewards_bps', 'u64'],
  ['holder_rewards', 'u64'],
];

/**
 * CreatePoolEvent (AMM) — emitted when a pool is created (including at
 * graduation migration). Carries BOTH mints' decimals — the authoritative
 * source for post-graduation decimal resolution.
 */
export const AMM_CREATE_POOL_EVENT_LAYOUT = [
  ['timestamp', 'i64'],
  ['index', 'u16'],
  ['creator', 'pubkey'],
  ['base_mint', 'pubkey'],
  ['quote_mint', 'pubkey'],
  ['base_mint_decimals', 'u8'],
  ['quote_mint_decimals', 'u8'],
  ['base_amount_in', 'u64'],
  ['quote_amount_in', 'u64'],
  ['pool_base_amount', 'u64'],
  ['pool_quote_amount', 'u64'],
  ['minimum_liquidity', 'u64'],
  ['initial_liquidity', 'u64'],
  ['lp_token_amount_out', 'u64'],
  ['pool_bump', 'u8'],
  ['pool', 'pubkey'],
  ['lp_mint', 'pubkey'],
  ['user_base_token_account', 'pubkey'],
  ['user_quote_token_account', 'pubkey'],
  ['coin_creator', 'pubkey'],
  ['is_mayhem_mode', 'bool'],
  ['creator_fee_bps', 'u64'],
  ['can_edit_creator_fee', 'bool'],
  ['is_holder_reward', 'bool'],
];

/** CollectCoinCreatorFeeEvent (AMM) — post-graduation creator fee claim. */
export const AMM_COLLECT_COIN_CREATOR_FEE_EVENT_LAYOUT = [
  ['timestamp', 'i64'],
  ['coin_creator', 'pubkey'],
  ['coin_creator_fee', 'u64'],
  ['coin_creator_vault_ata', 'pubkey'],
  ['coin_creator_token_account', 'pubkey'],
];

// ---------------------------------------------------------------------------
// Instruction discriminators (Anchor: sha256("global:<name>")[0..8]).
// Used ONLY to label which instruction an event belongs to (ix_name comes
// from the event itself) and to detect instruction types in instruction
// scans. Amounts NEVER come from instruction args — always from events.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';

export function anchorInstructionDiscriminator(name) {
  return [...createHash('sha256').update(`global:${name}`).digest().subarray(0, 8)];
}

export const PUMP_INSTRUCTION_NAMES = [
  'create',
  'create_v2',
  'buy',
  'buy_v2',
  'buy_exact_sol_in',
  'buy_exact_quote_in_v2',
  'sell',
  'sell_v2',
  'migrate',
  'migrate_v2',
  'collect_creator_fee',
  'collect_creator_fee_v2',
  'set_creator',
];

/** WSOL mint — the canonical SOL quote representation in AMM pools. */
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
/** Default pump token decimals (NOT assumed — resolved per mint; this is the fallback display hint only). */
export const PUMP_TOKEN_DECIMALS_HINT = 6;
