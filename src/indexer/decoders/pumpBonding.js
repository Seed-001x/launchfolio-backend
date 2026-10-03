// src/indexer/decoders/pumpBonding.js — PumpBondingDecoder (pump-bonding-v1).
//
// Decodes the Pump bonding-curve program (6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P)
// Anchor events from transaction logs into normalized shapes. This is the
// ONLY place in the codebase that understands Pump bonding-curve layouts.
//
// Amount semantics (verified from @pump-fun/pump-sdk v2.0.0 bondingCurve.ts):
//   BUY:  pair_amount_raw = event sol_amount = the user's TOTAL spend in
//         lamports (program takes fees out of it). This is the buyer's cost.
//   SELL: pair_amount_raw = event sol_amount = lamports the user RECEIVES net
//         (program deducts fees before paying out). This is the seller's proceeds.
//   token_amount_raw = event token_amount in both directions.
// Fee fields are the exact deducted portions (protocol / creator / cashback /
// buyback / holder_rewards), for fee accounting — never inferred.
//
// Graduations: CompletePumpAmmMigrationEvent (and the legacy CompleteEvent)
// mark BONDING → GRADUATED. The token record is UPDATED, never duplicated.
// Same-mint CreateEvent twice (replay/reorg) upserts, never duplicates.

import {
  PROGRAM_IDS,
  DECODER_VERSIONS,
  PUMP_EVENT_DISCRIMINATORS,
  TRADE_EVENT_LAYOUT,
  TRADE_EVENT_TRAILING_DEFAULT_BYTES,
  CREATE_EVENT_LAYOUT,
  COMPLETE_EVENT_LAYOUT,
  COMPLETE_PUMP_AMM_MIGRATION_EVENT_LAYOUT,
  COLLECT_CREATOR_FEE_EVENT_LAYOUT,
} from './layouts.js';
import { walkProgramDataEvents, matchEvent } from './walkLogs.js';
import { decodeLayout, fieldsToJson } from './decodeLayout.js';
import {
  makeNormalizedTrade,
  makeNormalizedLaunch,
  makeNormalizedGraduation,
  makeNormalizedFeeEvent,
} from './normalized.js';

const VERSION = DECODER_VERSIONS.PUMP_BONDING;
const PUMP = PROGRAM_IDS.PUMP;

function baseCtx(tx, confirmation) {
  return {
    decoder_version: VERSION,
    program: PUMP,
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

function decodeTradeEvent(f, ctx, evt) {
  const { rest: e, padded } = stripPadFlag(f);
  const isBuy = e.is_buy;
  const trade = makeNormalizedTrade({
    ...ctx,
    event_index: evt.eventIndex,
    instruction_index: evt.instructionIndex,
    inner_instruction_index: evt.innerInstructionIndex,
    wallet: e.user,
    mint: e.mint,
    side: isBuy ? 'BUY' : 'SELL',
    creator: e.creator,
    token_amount_raw: e.token_amount,
    token_decimals: null, // resolved by the orchestrator from the mint account
    pair_asset: 'SOL',
    pair_amount_raw: e.sol_amount,
    pair_decimals: 9,
    fee_protocol_raw: e.fee,
    fee_creator_raw: e.creator_fee,
    fee_cashback_raw: e.cashback,
    fee_buyback_raw: e.buyback_fee,
    fee_holder_rewards_raw: e.holder_rewards,
    fee_recipient: e.fee_recipient,
    reserves: {
      virtual_sol_reserves_raw: e.virtual_sol_reserves.toString(),
      virtual_token_reserves_raw: e.virtual_token_reserves.toString(),
      real_sol_reserves_raw: e.real_sol_reserves.toString(),
      real_token_reserves_raw: e.real_token_reserves.toString(),
      quote_mint: e.quote_mint,
      quote_amount_raw: e.quote_amount.toString(),
    },
    ix_name: e.ix_name,
    event_name: 'TradeEvent',
    raw: { ...fieldsToJson(e), __padded_legacy_layout: padded },
  });

  // Per-trade fee events for accounting (exact, from the event).
  const fees = [];
  const feeKinds = [
    ['protocol_fee', e.fee, e.fee_recipient],
    ['creator_fee', e.creator_fee, e.creator],
    ['cashback', e.cashback, null],
    ['buyback_fee', e.buyback_fee, null],
    ['holder_rewards', e.holder_rewards, null],
  ];
  for (const [fee_type, amount, recipient] of feeKinds) {
    if (amount > 0n) {
      fees.push(
        makeNormalizedFeeEvent({
          decoder_version: VERSION,
          signature: ctx.signature,
          event_index: evt.eventIndex,
          slot: ctx.slot,
          block_time: ctx.block_time,
          mint: e.mint,
          fee_type,
          amount_raw: amount,
          amount_decimals: 9,
          recipient,
          attribution: 'event',
        })
      );
    }
  }
  return { trade, fees };
}

function decodeCreateEvent(f, ctx, evt) {
  const { rest: e, padded } = stripPadFlag(f);
  return makeNormalizedLaunch({
    ...ctx,
    event_index: evt.eventIndex,
    instruction_index: evt.instructionIndex,
    mint: e.mint,
    creator: e.creator,
    launcher_wallet: e.user,
    name: e.name,
    ticker: e.symbol,
    metadata_uri: e.uri,
    bonding_curve: e.bonding_curve,
    token_program: e.token_program,
    pair_asset: 'SOL',
    raw: { ...fieldsToJson(e), __padded_legacy_layout: padded },
  });
}

function decodeGraduationEvent(f, ctx, evt, legacy) {
  const { rest: e, padded } = stripPadFlag(f);
  return makeNormalizedGraduation({
    ...ctx,
    event_index: evt.eventIndex,
    mint: e.mint,
    pool: legacy ? null : e.pool,
    raw: { ...fieldsToJson(e), __padded_legacy_layout: padded, legacy },
  });
}

function decodeCollectCreatorFee(f, ctx, evt) {
  const { rest: e } = stripPadFlag(f);
  return makeNormalizedFeeEvent({
    decoder_version: VERSION,
    signature: ctx.signature,
    event_index: evt.eventIndex,
    slot: ctx.slot,
    block_time: ctx.block_time,
    mint: null, // creator-fee claims pool across the creator's coins; attribution is per-claim
    fee_type: 'creator_fee_claim',
    amount_raw: e.creator_fee,
    amount_decimals: 9,
    recipient: e.creator,
    attribution: 'event',
    raw: fieldsToJson(e),
  });
}

const EVENT_LAYOUTS = {
  TradeEvent: [TRADE_EVENT_LAYOUT, TRADE_EVENT_TRAILING_DEFAULT_BYTES],
  CreateEvent: [CREATE_EVENT_LAYOUT, 0],
  CompleteEvent: [COMPLETE_EVENT_LAYOUT, 0],
  CompletePumpAmmMigrationEvent: [COMPLETE_PUMP_AMM_MIGRATION_EVENT_LAYOUT, 0],
  CollectCreatorFeeEvent: [COLLECT_CREATOR_FEE_EVENT_LAYOUT, 0],
  // DistributeCreatorFeesEvent and SetCreatorEvent are control-plane events;
  // they carry no per-trade economics and are skipped, not failures.
};

/**
 * Decode one transaction's Pump bonding-curve events.
 *
 * @param {Object} tx - getTransaction JSON (encoding json, any version).
 * @param {Object} opts - { confirmation }
 * @returns { trades, launches, graduations, feeEvents, failures }
 *   failures: [{ signature, eventIndex, stage, error }] — caller queues them.
 */
export function decodePumpBondingTransaction(tx, opts = {}) {
  const out = { trades: [], launches: [], graduations: [], feeEvents: [], failures: [] };

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
    // Failed transactions mutate nothing on-chain; their logs are not economics.
    return { ...out, skipped: 'failed-transaction' };
  }

  const logs = tx.meta.logMessages || [];
  const ctx = baseCtx(tx, opts.confirmation);
  let eventIndex = 0;

  let events;
  try {
    events = walkProgramDataEvents(logs, tx, new Set([PUMP]));
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
    const matched = matchEvent(evt.dataBase64, PUMP_EVENT_DISCRIMINATORS);
    if (!matched) continue; // unknown Program data: line — skip, not a failure
    const layout = EVENT_LAYOUTS[matched.name];
    if (!layout) continue; // recognized but economically irrelevant — skip
    const evtCtx = { eventIndex: eventIndex++, ...evt };

    try {
      const fields = decodeLayout(matched.payload, layout[0], layout[1]);
      switch (matched.name) {
        case 'TradeEvent': {
          const { trade, fees } = decodeTradeEvent(fields, ctx, evtCtx);
          out.trades.push(trade);
          out.feeEvents.push(...fees);
          break;
        }
        case 'CreateEvent':
          out.launches.push(decodeCreateEvent(fields, ctx, evtCtx));
          break;
        case 'CompleteEvent':
          out.graduations.push(decodeGraduationEvent(fields, ctx, evtCtx, true));
          break;
        case 'CompletePumpAmmMigrationEvent':
          out.graduations.push(decodeGraduationEvent(fields, ctx, evtCtx, false));
          break;
        case 'CollectCreatorFeeEvent':
          out.feeEvents.push(decodeCollectCreatorFee(fields, ctx, evtCtx));
          break;
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
