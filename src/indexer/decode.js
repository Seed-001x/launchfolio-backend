// src/indexer/decode.js — decode orchestrator: normalized events → database.
//
// Pipeline per transaction:
//   1. decodePumpBondingTransaction + decodePumpSwapTransaction (pure decoders)
//   2. upsert amm_pools from CreatePoolEvent (pool attribution source)
//   3. upsert tokens from launches (launch_origin NEVER downgraded from
//      LAUNCHFOLIO; the decoder cannot infer Launchfolio origin)
//   4. apply graduations (UPDATE lifecycle, never duplicate token rows)
//   5. resolve token decimals (cache → tokens.decimals → RPC mint account)
//   6. insert trades idempotently (signature, event_index)
//   7. reconcile each trade against on-chain balance deltas (tripwire:
//      mismatches are queued as decode_failures, never block the trade)
//   8. insert fee_events idempotently
//   9. queue decode_failures (never silent)
//   10. update indexer_stats
//
// Failed transactions (meta.err) are excluded from ALL economic state.
// UNKNOWN ≠ ZERO: unresolved decimals/amounts stay NULL with the raw value
// preserved; legacy DOUBLE columns are best-effort approximations for
// backward compatibility and are documented as non-authoritative.

import { decodePumpBondingTransaction } from './decoders/pumpBonding.js';
import { decodePumpSwapTransaction } from './decoders/pumpSwap.js';
import { walkProgramDataEvents, matchEvent } from './decoders/walkLogs.js';
import { decodeLayout } from './decoders/decodeLayout.js';
import {
  PROGRAM_IDS,
  PUMP_AMM_EVENT_DISCRIMINATORS,
  AMM_CREATE_POOL_EVENT_LAYOUT,
  DECODER_VERSIONS,
} from './decoders/layouts.js';
import { serializeTrade, makeNormalizedFeeEvent } from './decoders/normalized.js';
import { reconcileTradeAmounts } from './reconcileTrade.js';
import { fromRawInt, toDecimalString } from '../engines/money.js';
import { createHash } from 'node:crypto';

// In-memory decimals cache: mint → decimals (int) | null (unresolvable).
const decimalsCache = new Map();

export function clearDecimalsCache() {
  decimalsCache.clear();
}

/**
 * Resolve an SPL mint's decimals. Order: memory cache → tokens.decimals →
 * amm_pools (base) → RPC mint account (byte 44 of the mint layout, both
 * Token and Token-2022). Returns { decimals: number|null, source }.
 * null = unresolvable; the caller stores NULL, never a guess.
 */
export async function resolveTokenDecimals(pool, mint, getMintAccountInfo) {
  if (decimalsCache.has(mint)) {
    return { decimals: decimalsCache.get(mint), source: 'cache' };
  }
  const { rows } = await pool.query('SELECT decimals FROM tokens WHERE mint = $1', [mint]);
  if (rows[0]?.decimals != null) {
    decimalsCache.set(mint, rows[0].decimals);
    return { decimals: rows[0].decimals, source: 'db' };
  }
  const { rows: prow } = await pool.query(
    'SELECT base_decimals FROM amm_pools WHERE base_mint = $1 LIMIT 1',
    [mint]
  );
  if (prow[0]?.base_decimals != null) {
    decimalsCache.set(mint, prow[0].base_decimals);
    return { decimals: prow[0].base_decimals, source: 'amm_pool' };
  }
  if (getMintAccountInfo) {
    try {
      const info = await getMintAccountInfo(mint);
      if (info === null) {
        // Account definitively does not exist — cache the negative.
        decimalsCache.set(mint, null);
        return { decimals: null, source: 'unresolvable' };
      }
      const data = info?.data;
      const buf = Buffer.isBuffer(data) ? data : data ? Buffer.from(data[0], 'base64') : null;
      // SPL mint layout: mintAuthority (36 bytes) + supply (8 bytes) → decimals at 44.
      if (buf && buf.length > 44) {
        const d = buf.readUInt8(44);
        decimalsCache.set(mint, d);
        await pool.query('UPDATE tokens SET decimals = $2 WHERE mint = $1', [mint, d]);
        return { decimals: d, source: 'rpc' };
      }
      // Malformed response — do NOT cache; retry next time.
      return { decimals: null, source: 'unresolved' };
    } catch {
      // Transient RPC failure — do NOT cache the negative; retry next time.
      return { decimals: null, source: 'unresolved' };
    }
  }
  return { decimals: null, source: 'unresolved' };
}

/** Best-effort legacy double from a raw integer + decimals (documented approximation). */
function legacyDouble(rawBigint, decimals) {
  const raw = BigInt(rawBigint);
  if (decimals == null) return Number(raw); // raw units; non-authoritative, documented
  return Number(raw) / 10 ** Number(decimals);
}

function toBlockTime(blockTime) {
  return blockTime != null ? new Date(Number(blockTime) * 1000).toISOString() : null;
}

async function upsertPoolCreations(pool, creations) {
  for (const c of creations) {
    await pool.query(
      `INSERT INTO amm_pools (pool, base_mint, quote_mint, base_decimals, quote_decimals,
                              creator, coin_creator, created_slot, created_at,
                              decoder_version, first_seen_sig)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (pool) DO NOTHING`,
      [
        c.pool, c.base_mint, c.quote_mint, c.base_decimals, c.quote_decimals,
        c.creator, c.coin_creator, c.slot, toBlockTime(c.block_time),
        c.decoder_version, c.signature,
      ]
    );
  }
}

async function poolResolver(pool) {
  // Snapshot pool attribution into memory BEFORE the swap decode: the
  // decoder stays pure and synchronous (no I/O mid-decode). Called after
  // preUpsertPoolsFromTx so same-tx pool creations are visible.
  // (amm_pools is one row per pool — tiny table; full snapshot is cheap.)
  const { rows } = await pool.query(
    'SELECT pool, base_mint, quote_mint, base_decimals, quote_decimals FROM amm_pools'
  );
  const byPool = new Map(rows.map((r) => [r.pool, r]));
  return (poolAddr) => byPool.get(poolAddr) || null;
}

async function upsertTokenFromLaunch(pool, launch) {
  // Never overwrite a richer row; never downgrade LAUNCHFOLIO origin.
  await pool.query(
    `INSERT INTO tokens (mint, name, ticker, creator_wallet, created_at,
                         launch_provider, launch_origin, launch_state,
                         pair_asset, decoder_version)
     VALUES ($1,$2,$3,$4,$5,'pump','EXTERNAL_PUMP','bonding',$6,$7)
     ON CONFLICT (mint) DO UPDATE SET
       name = COALESCE(tokens.name, EXCLUDED.name),
       ticker = COALESCE(tokens.ticker, EXCLUDED.ticker),
       creator_wallet = COALESCE(tokens.creator_wallet, EXCLUDED.creator_wallet),
       created_at = COALESCE(tokens.created_at, EXCLUDED.created_at),
       decoder_version = COALESCE(tokens.decoder_version, EXCLUDED.decoder_version)`,
    [
      launch.mint, launch.name, launch.ticker, launch.creator,
      toBlockTime(launch.block_time), launch.pair_asset, launch.decoder_version,
    ]
  );
  // Upgrade to LAUNCHFOLIO origin only when the launch went through our flow.
  const { rows } = await pool.query('SELECT 1 FROM launch_records WHERE mint = $1', [launch.mint]);
  if (rows.length) {
    await pool.query(
      `UPDATE tokens SET launch_origin = 'LAUNCHFOLIO' WHERE mint = $1 AND launch_origin <> 'LAUNCHFOLIO'`,
      [launch.mint]
    );
  }
}

async function applyGraduation(pool, graduation) {
  // Graduation applies exactly once per mint, keyed on the authoritative
  // graduation_signature (not the state label): a token first seen via its
  // PumpSwap pool may already be labeled 'graduated' before its migration
  // event is processed — the event must still backfill signature/time.
  // Replays are no-ops.
  await pool.query(
    `UPDATE tokens
     SET launch_state = 'graduated',
         graduation_signature = COALESCE(graduation_signature, $2),
         graduated_at = COALESCE(graduated_at, $3),
         pool_address = COALESCE(pool_address, $4)
     WHERE mint = $1 AND graduation_signature IS NULL`,
    [graduation.mint, graduation.signature, toBlockTime(graduation.block_time), graduation.pool]
  );
}

async function ensureTokenRow(pool, mint) {
  await pool.query(
    `INSERT INTO tokens (mint, launch_provider, launch_origin, launch_state)
     VALUES ($1, 'pump', 'EXTERNAL_PUMP', 'bonding')
     ON CONFLICT (mint) DO NOTHING`,
    [mint]
  );
}

/**
 * Token-row bootstrap for PumpSwap trades. A PumpSwap pool trade is only
 * possible after the bonding curve was migrated (the migration transaction
 * closes the curve and creates the pool atomically), so a token first seen
 * via its pool is recorded as 'graduated'. This is a documented
 * best-estimate for backfills that start after migration: the graduation
 * EVENT remains authoritative and backfills graduation_signature /
 * graduated_at via applyGraduation when observed. Edge case: a
 * permissionless (non-migration) pool for the same mint would share the
 * label — pool_address disambiguates via the migration record.
 *
 * An existing 'bonding' row is upgraded ONLY when a graduation_signature is
 * on record — the label is never inferred from swap activity alone.
 */
async function ensureTokenRowForSwap(pool, mint, poolAddr) {
  await pool.query(
    `INSERT INTO tokens (mint, launch_provider, launch_origin, launch_state, pool_address)
     VALUES ($1, 'pump', 'EXTERNAL_PUMP', 'graduated', $2)
     ON CONFLICT (mint) DO UPDATE SET
       launch_state = CASE
         WHEN tokens.launch_state = 'bonding' AND tokens.graduation_signature IS NOT NULL
         THEN 'graduated'
         ELSE tokens.launch_state
       END,
       pool_address = COALESCE(tokens.pool_address, EXCLUDED.pool_address)`,
    [mint, poolAddr ?? null]
  );
}

/** Exact decimal string for a raw amount (money.js rational engine, never floats). */
function normalizedDecimal(rawStr, decimals) {
  if (rawStr == null || decimals == null) return null;
  try {
    return toDecimalString(fromRawInt(rawStr, decimals), 18);
  } catch {
    return null;
  }
}

async function insertTrade(pool, trade) {
  const s = serializeTrade(trade);
  const feeBreakdown = {
    fee_protocol_raw: s.fee_protocol_raw,
    fee_creator_raw: s.fee_creator_raw,
    fee_lp_raw: s.fee_lp_raw,
    fee_cashback_raw: s.fee_cashback_raw,
    fee_buyback_raw: s.fee_buyback_raw,
    fee_holder_rewards_raw: s.fee_holder_rewards_raw,
    fee_recipient: s.fee_recipient,
  };
  const legacyToken = legacyDouble(s.token_amount_raw, s.token_decimals);
  const legacyPair = legacyDouble(s.pair_amount_raw, s.pair_decimals);
  const execPrice =
    s.token_amount_raw !== '0' && s.token_decimals != null && s.pair_decimals != null
      ? legacyPair / legacyToken
      : null;
  await pool.query(
    `INSERT INTO trades (signature, event_index, wallet, mint, side,
                         token_amount, pair_amount, execution_price,
                         slot, block_time, confirmation,
                         token_amount_raw, pair_amount_raw,
                         token_decimals, pair_decimals,
                         decoder_version, provider,
                         instruction_index, inner_instruction_index,
                         fee_breakdown,
                         program, ix_name, event_name,
                         token_amount_normalized, pair_amount_normalized)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
             $21,$22,$23,$24,$25)
     ON CONFLICT (signature, event_index) DO NOTHING`,
    [
      s.signature, s.event_index, s.wallet, s.mint, s.side,
      legacyToken, legacyPair, execPrice,
      s.slot, toBlockTime(s.block_time), s.confirmation,
      s.token_amount_raw, s.pair_amount_raw,
      s.token_decimals, s.pair_decimals,
      s.decoder_version, s.provider,
      s.instruction_index, s.inner_instruction_index,
      JSON.stringify(feeBreakdown),
      s.program, s.ix_name, s.event_name,
      normalizedDecimal(s.token_amount_raw, s.token_decimals),
      normalizedDecimal(s.pair_amount_raw, s.pair_decimals),
    ]
  );
}

/** Deterministic NULL-safe idempotency key for a fee event. */
function feeDedupeKey(fee) {
  return createHash('sha256')
    .update(
      `${fee.trade_signature}|${fee.event_index ?? 0}|${fee.fee_type}|${fee.recipient ?? ''}|${fee.amount_raw.toString()}`
    )
    .digest('hex');
}

async function insertFeeEvent(pool, fee) {
  const amount = legacyDouble(fee.amount_raw, fee.amount_decimals);
  await pool.query(
    `INSERT INTO fee_events (mint, trade_signature, fee_type, amount, recipient,
                             provider, block_time, decoder_version,
                             amount_raw, amount_decimals, event_index, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [
      fee.mint, fee.trade_signature, fee.fee_type, amount, fee.recipient,
      fee.provider, toBlockTime(fee.block_time), fee.decoder_version,
      fee.amount_raw.toString(), fee.amount_decimals,
      fee.event_index ?? 0, feeDedupeKey(fee),
    ]
  );
}

async function queueFailure(pool, job, signature, eventIndex, stage, error, rawTx = null) {
  await pool.query(
    `INSERT INTO decode_failures (signature, event_index, job, stage, error, attempts, last_attempt_at, raw_tx)
     VALUES ($1,$2,$3,$4,$5,1,NOW(),$6)
     ON CONFLICT (signature, event_index, stage)
     DO UPDATE SET attempts = decode_failures.attempts + 1,
                   last_attempt_at = NOW(),
                   error = EXCLUDED.error,
                   raw_tx = COALESCE(EXCLUDED.raw_tx, decode_failures.raw_tx),
                   resolved = FALSE`,
    [signature, eventIndex, job, stage, String(error).slice(0, 2000), rawTx ? JSON.stringify(rawTx) : null]
  );
}

async function bumpStats(pool, job, delta) {
  await pool.query(
    `INSERT INTO indexer_stats (job, last_cycle_at, txs_seen, txs_decoded,
                                txs_skipped_failed, events_decoded, events_failed,
                                reconcile_mismatches, last_error, decoder_version)
     VALUES ($1, NOW(), $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (job) DO UPDATE SET
       last_cycle_at = NOW(),
       txs_seen = indexer_stats.txs_seen + EXCLUDED.txs_seen,
       txs_decoded = indexer_stats.txs_decoded + EXCLUDED.txs_decoded,
       txs_skipped_failed = indexer_stats.txs_skipped_failed + EXCLUDED.txs_skipped_failed,
       events_decoded = indexer_stats.events_decoded + EXCLUDED.events_decoded,
       events_failed = indexer_stats.events_failed + EXCLUDED.events_failed,
       reconcile_mismatches = indexer_stats.reconcile_mismatches + EXCLUDED.reconcile_mismatches,
       last_error = COALESCE(EXCLUDED.last_error, indexer_stats.last_error),
       decoder_version = COALESCE(EXCLUDED.decoder_version, indexer_stats.decoder_version)`,
    [
      job, delta.txs_seen, delta.txs_decoded, delta.txs_skipped_failed,
      delta.events_decoded, delta.events_failed, delta.reconcile_mismatches || 0,
      delta.last_error || null, delta.decoder_version || null,
    ]
  );
}

/**
 * Pre-pass: extract CreatePoolEvent pool creations from a transaction's logs
 * and upsert them BEFORE the main PumpSwap decode, so trades in the SAME
 * transaction (e.g. migrate + first AMM swap) resolve their pool attribution.
 * Idempotent — the main decode re-encounters the event and upserts again.
 */
async function preUpsertPoolsFromTx(pool, tx, confirmation) {
  const logs = tx.meta?.logMessages || [];
  const events = walkProgramDataEvents(logs, tx, new Set([PROGRAM_IDS.PUMP_AMM]));
  const creations = [];
  for (const evt of events) {
    const matched = matchEvent(evt.dataBase64, PUMP_AMM_EVENT_DISCRIMINATORS);
    if (!matched || matched.name !== 'CreatePoolEvent') continue;
    try {
      const f = decodeLayout(matched.payload, AMM_CREATE_POOL_EVENT_LAYOUT, 0);
      creations.push({
        decoder_version: DECODER_VERSIONS.PUMP_SWAP,
        signature: tx.transaction.signatures[0],
        slot: tx.slot ?? null,
        block_time: tx.blockTime ?? null,
        pool: f.pool,
        base_mint: f.base_mint,
        quote_mint: f.quote_mint,
        base_decimals: f.base_mint_decimals,
        quote_decimals: f.quote_mint_decimals,
        creator: f.creator,
        coin_creator: f.coin_creator,
      });
    } catch {
      // Corrupt pool event → main decode records the failure; skip here.
    }
  }
  await upsertPoolCreations(pool, creations);
}

/**
 * Decode one transaction and persist its economics.
 *
 * @param {Object} pool - pg pool
 * @param {Object} tx - getTransaction JSON
 * @param {Object} opts - { job, confirmation, getMintAccountInfo }
 * @returns stats delta { txs_seen, txs_decoded, txs_skipped_failed, events_decoded,
 *   events_failed, reconcile_mismatches }
 */
export async function processTransaction(pool, tx, opts = {}) {
  const job = opts.job || 'pump-bonding';
  const stats = { txs_seen: 1, txs_decoded: 0, txs_skipped_failed: 0, events_decoded: 0, events_failed: 0, reconcile_mismatches: 0 };

  const bonding = decodePumpBondingTransaction(tx, { confirmation: opts.confirmation });
  if (bonding.skipped === 'failed-transaction') {
    stats.txs_skipped_failed = 1;
    await bumpStats(pool, job, stats);
    return { ...stats, skipped: 'failed-transaction' };
  }

  // Pool creations first — PumpSwap trades in the SAME tx may reference them
  // (pre-pass handles same-tx create_pool + swap; the full decode re-upserts).
  await preUpsertPoolsFromTx(pool, tx, opts.confirmation);
  await upsertPoolCreations(pool, bonding.poolCreations || []);

  const swap = decodePumpSwapTransaction(tx, {
    confirmation: opts.confirmation,
    resolvePool: await poolResolver(pool),
  });
  await upsertPoolCreations(pool, swap.poolCreations);

  const trades = [...bonding.trades, ...swap.trades];
  const launches = bonding.launches;
  const graduations = bonding.graduations;
  const feeEvents = [...bonding.feeEvents, ...swap.feeEvents];
  const failures = [...bonding.failures, ...swap.failures];

  // Network fee: exact from the transaction meta (paid by the fee payer to
  // validators). Attributed, never estimated.
  if (tx.meta && tx.meta.fee > 0) {
    feeEvents.push(
      makeNormalizedFeeEvent({
        decoder_version: DECODER_VERSIONS.PUMP_BONDING,
        signature: tx.transaction.signatures[0],
        event_index: 0,
        slot: tx.slot ?? null,
        block_time: tx.blockTime ?? null,
        mint: null,
        fee_type: 'network_fee',
        amount_raw: BigInt(tx.meta.fee),
        amount_decimals: 9,
        recipient: null, // validators; not attributable to an address
        attribution: 'event',
      })
    );
  }

  for (const launch of launches) await upsertTokenFromLaunch(pool, launch);
  for (const g of graduations) await applyGraduation(pool, g);

  const swapSigs = new Set(swap.trades.map((t) => `${t.signature}|${t.event_index}`));
  for (const trade of trades) {
    const isSwap = swapSigs.has(`${trade.signature}|${trade.event_index}`);
    if (isSwap) {
      await ensureTokenRowForSwap(pool, trade.mint, trade.reserves?.pool ?? null);
    } else {
      await ensureTokenRow(pool, trade.mint);
    }
    const { decimals } = await resolveTokenDecimals(pool, trade.mint, opts.getMintAccountInfo);
    trade.token_decimals = decimals;
    if (trade.pair_asset === 'SOL' && trade.pair_decimals == null) trade.pair_decimals = 9;
    await insertTrade(pool, trade);
    stats.events_decoded++;

    // STEP 12: independent balance reconciliation. The decoded event stays
    // authoritative — a mismatch never blocks the trade; it is queued for
    // investigation with the raw tx meta preserved.
    const rec = reconcileTradeAmounts(trade, tx);
    trade.reconciliation = rec;
    if (rec.mismatch) {
      await queueFailure(
        pool, job, trade.signature, trade.event_index, 'reconcile:trade',
        `reconcile mismatch: ${rec.summary} | detail=${JSON.stringify(rec.checks)}`,
        tx.meta ?? null
      );
      stats.reconcile_mismatches = (stats.reconcile_mismatches || 0) + 1;
    }
  }

  for (const fee of feeEvents) {
    if (fee.mint) await ensureTokenRow(pool, fee.mint);
    await insertFeeEvent(pool, fee);
    stats.events_decoded++;
  }

  for (const f of failures) {
    await queueFailure(pool, job, f.signature, f.eventIndex ?? null, f.stage, f.error);
    stats.events_failed++;
  }

  stats.txs_decoded = 1;
  await bumpStats(pool, job, stats);
  return stats;
}
