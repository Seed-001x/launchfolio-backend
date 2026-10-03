// src/indexer/decoders/pumpSwap.js — PumpSwapDecoder (pumpswap-v1).
//
// Decodes the PumpSwap AMM program (pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA)
// Anchor events from transaction logs. This is the ONLY place that understands
// PumpSwap layouts.
//
// Post-graduation trades settle against the AMM pool, not the bonding curve:
//   BUY:  token_amount_raw = base_amount_out (tokens the user receives)
//         pair_amount_raw  = user_quote_amount_in (quote the user pays)
//   SELL: token_amount_raw = base_amount_in (tokens the user sells)
//         pair_amount_raw  = user_quote_amount_out (quote the user receives net)
// Fee fields (lp_fee, protocol_fee, coin_creator_fee, cashback, buyback_fee,
// holder_rewards) are the exact deducted portions for accounting.
//
// Pool attribution: AMM trade events carry the `pool` address but NOT the
// base/quote mints. The orchestrator supplies `opts.resolvePool(pool)` backed
// by the amm_pools table (populated from CreatePoolEvent, which carries both
// mints' decimals). An unknown pool is a decode FAILURE — the token is never
// guessed — and the pool creation event itself seeds the table.

import {
  PROGRAM_IDS,
  DECODER_VERSIONS,
  PUMP_AMM_EVENT_DISCRIMINATORS,
  AMM_BUY_EVENT_LAYOUT,
  AMM_SELL_EVENT_LAYOUT,
  AMM_CREATE_POOL_EVENT_LAYOUT,
  AMM_COLLECT_COIN_CREATOR_FEE_EVENT_LAYOUT,
  AMM_EVENT_TRAILING_DEFAULT_BYTES,
  WSOL_MINT,
} from './layouts.js';
import { walkProgramDataEvents, matchEvent } from './walkLogs.js';
import { decodeLayout, fieldsToJson } from './decodeLayout.js';
import {
  makeNormalizedTrade,
  makeNormalizedFeeEvent,
} from './normalized.js';

const VERSION = DECODER_VERSIONS.PUMP_SWAP;
const AMM = PROGRAM_IDS.PUMP_AMM;

function baseCtx(tx, confirmation) {
  return {
    decoder_version: VERSION,
    program: AMM,
    signature: tx.transaction.signatures[0],
    slot: tx.slot ?? null,
    block_time: tx.blockTime ?? null,
    confirmation: confirmation ?? 'confirmed',
  };
}

function stripPadFlag(fields) {
  const { __padded_legacy_layout, ...rest } = fields;
  return { rest, padded: __padded_legacy_layout === true };
}

function ammFeeEvents(e, ctx, eventIndex) {
  const out = [];
  const kinds = [
    ['protocol_fee', e.protocol_fee, e.protocol_fee_recipient],
    ['creator_fee', e.coin_creator_fee, e.coin_creator],
    ['lp_fee', e.lp_fee, null],
    ['cashback', e.cashback, null],
    ['buyback_fee', e.buyback_fee, null],
    ['holder_rewards', e.holder_rewards, null],
  ];
  for (const [fee_type, amount, recipient] of kinds) {
    if (amount > 0n) {
      out.push(
        makeNormalizedFeeEvent({
          decoder_version: VERSION,
          signature: ctx.signature,
          event_index: eventIndex,
          slot: ctx.slot,
          block_time: ctx.block_time,
          mint: null, // filled by the orchestrator from pool resolution
          fee_type,
          amount_raw: amount,
          amount_decimals: null, // resolved from quote decimals
          recipient,
          attribution: 'event',
        })
      );
    }
  }
  return out;
}

function decodeAmmTrade(e, padded, ctx, evt, poolInfo, isBuy) {
  const pairAsset = poolInfo.quote_mint === WSOL_MINT ? 'SOL' : poolInfo.quote_mint;
  return makeNormalizedTrade({
    ...ctx,
    event_index: evt.eventIndex,
    instruction_index: evt.instructionIndex,
    inner_instruction_index: evt.innerInstructionIndex,
    wallet: e.user,
    mint: poolInfo.base_mint,
    side: isBuy ? 'BUY' : 'SELL',
    creator: e.coin_creator,
    token_amount_raw: isBuy ? e.base_amount_out : e.base_amount_in,
    token_decimals: poolInfo.base_decimals,
    pair_asset: pairAsset,
    pair_amount_raw: isBuy ? e.user_quote_amount_in : e.user_quote_amount_out,
    pair_decimals: poolInfo.quote_decimals,
    fee_protocol_raw: e.protocol_fee,
    fee_creator_raw: e.coin_creator_fee,
    fee_lp_raw: e.lp_fee,
    fee_cashback_raw: e.cashback,
    fee_buyback_raw: e.buyback_fee,
    fee_holder_rewards_raw: e.holder_rewards,
    fee_recipient: e.protocol_fee_recipient,
    reserves: {
      pool_base_token_reserves_raw: e.pool_base_token_reserves.toString(),
      pool_quote_token_reserves_raw: e.pool_quote_token_reserves.toString(),
      pool: e.pool,
    },
    // The AMM quote leg is a token (WSOL for SOL-quoted pools); the
    // reconciler needs the mint to attribute wrap/unwrap flows.
    quote_mint: poolInfo.quote_mint,
    ix_name: e.ix_name,
    event_name: isBuy ? 'BuyEvent' : 'SellEvent',
    raw: { ...fieldsToJson(e), __padded_legacy_layout: padded, pool: e.pool },
  });
}

const EVENT_LAYOUTS = {
  BuyEvent: [AMM_BUY_EVENT_LAYOUT, AMM_EVENT_TRAILING_DEFAULT_BYTES],
  SellEvent: [AMM_SELL_EVENT_LAYOUT, AMM_EVENT_TRAILING_DEFAULT_BYTES],
  CreatePoolEvent: [AMM_CREATE_POOL_EVENT_LAYOUT, 0],
  CollectCoinCreatorFeeEvent: [AMM_COLLECT_COIN_CREATOR_FEE_EVENT_LAYOUT, 0],
};

/**
 * Decode one transaction's PumpSwap events.
 *
 * @param {Object} tx - getTransaction JSON.
 * @param {Object} opts - { confirmation, resolvePool(poolBase58) → poolInfo|null }
 * @returns { trades, poolCreations, feeEvents, failures }
 */
export function decodePumpSwapTransaction(tx, opts = {}) {
  const out = { trades: [], poolCreations: [], feeEvents: [], failures: [] };

  if (!tx || !tx.meta || !tx.transaction) {
    out.failures.push({
      signature: tx?.transaction?.signatures?.[0] ?? 'unknown',
      eventIndex: null,
      stage: 'tx-shape',
      error: 'transaction missing meta or message',
    });
    return out;
  }
  if (tx.meta.err) {
    return { ...out, skipped: 'failed-transaction' };
  }

  const logs = tx.meta.logMessages || [];
  const ctx = baseCtx(tx, opts.confirmation);
  const resolvePool = opts.resolvePool || (() => null);
  let eventIndex = 0;

  let events;
  try {
    events = walkProgramDataEvents(logs, tx, new Set([AMM]));
  } catch (err) {
    out.failures.push({
      signature: ctx.signature,
      eventIndex: null,
      stage: 'log-walk',
      error: String(err?.message || err),
    });
    return out;
  }

  for (const evt of events) {
    const matched = matchEvent(evt.dataBase64, PUMP_AMM_EVENT_DISCRIMINATORS);
    if (!matched) continue;
    const layout = EVENT_LAYOUTS[matched.name];
    if (!layout) continue;
    const evtCtx = { eventIndex: eventIndex++, ...evt };

    try {
      const fields = decodeLayout(matched.payload, layout[0], layout[1]);
      const { rest: e, padded } = stripPadFlag(fields);

      if (matched.name === 'CreatePoolEvent') {
        out.poolCreations.push({
          decoder_version: VERSION,
          signature: ctx.signature,
          slot: ctx.slot,
          block_time: ctx.block_time,
          pool: e.pool,
          base_mint: e.base_mint,
          quote_mint: e.quote_mint,
          base_decimals: e.base_mint_decimals,
          quote_decimals: e.quote_mint_decimals,
          creator: e.creator,
          coin_creator: e.coin_creator,
        });
        continue;
      }

      if (matched.name === 'CollectCoinCreatorFeeEvent') {
        out.feeEvents.push(
          makeNormalizedFeeEvent({
            decoder_version: VERSION,
            signature: ctx.signature,
            event_index: evtCtx.eventIndex,
            slot: ctx.slot,
            block_time: ctx.block_time,
            mint: null,
            fee_type: 'creator_fee_claim',
            amount_raw: e.coin_creator_fee,
            amount_decimals: null,
            recipient: e.coin_creator,
            attribution: 'event',
            raw: fieldsToJson(e),
          })
        );
        continue;
      }

      // BuyEvent / SellEvent — require pool attribution; never guess the mint.
      const isBuy = matched.name === 'BuyEvent';
      const poolInfo = resolvePool(e.pool);
      if (!poolInfo || !poolInfo.base_mint) {
        out.failures.push({
          signature: ctx.signature,
          eventIndex: evtCtx.eventIndex,
          stage: `pool-resolution:${matched.name}`,
          error: `unknown pool ${e.pool} — token mint cannot be attributed`,
        });
        continue;
      }
      const trade = decodeAmmTrade(e, padded, ctx, evtCtx, poolInfo, isBuy);
      trade.mint = poolInfo.base_mint;
      out.trades.push(trade);
      const fees = ammFeeEvents(e, ctx, evtCtx.eventIndex);
      for (const f of fees) {
        f.mint = poolInfo.base_mint;
        f.amount_decimals = poolInfo.quote_decimals;
        out.feeEvents.push(f);
      }
    } catch (err) {
      out.failures.push({
        signature: ctx.signature,
        eventIndex: evtCtx.eventIndex,
        stage: `decode:${matched.name}`,
        error: String(err?.message || err),
      });
    }
  }

  return out;
}
