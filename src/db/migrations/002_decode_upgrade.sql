-- 002_decode_upgrade.sql — Pump indexer decode upgrade.
--
-- What changes and why:
--   * trades: exact on-chain amounts. New raw columns (TEXT holding decimal
--     strings of the full u64) are AUTHORITATIVE. The legacy DOUBLE columns
--     remain for backward compatibility but are non-authoritative (documented
--     as approximations in README). decoder_version records which decoder
--     produced each row so future layout changes can be re-backfilled.
--   * tokens: decimals + graduation fields (BONDING → GRADUATED lifecycle).
--   * positions: exact quantity / cost basis strings (BigInt math in engine).
--   * fee_events: decoder version for re-backfill scoping.
--   * NEW amm_pools: pool → base/quote mint + decimals, seeded from
--     CreatePoolEvent (the authoritative post-graduation decimals source).
--   * NEW decode_failures: the retry queue. A failed decode is NEVER silent:
--     every failure lands here with stage + error + retry bookkeeping.
--   * NEW indexer_stats: per-job decode counters for /health and ops.
--
-- UNKNOWN ≠ ZERO: new amount columns are NULLABLE with no default 0; a NULL
-- means "not resolved", never "zero".

-- ---------------------------------------------------------------- trades
ALTER TABLE trades ADD COLUMN IF NOT EXISTS token_amount_raw TEXT;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS pair_amount_raw TEXT;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS token_decimals INTEGER;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS pair_decimals INTEGER;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS decoder_version TEXT;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'pump';
ALTER TABLE trades ADD COLUMN IF NOT EXISTS instruction_index INTEGER;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS inner_instruction_index INTEGER;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS fee_breakdown JSONB NOT NULL DEFAULT '{}';
ALTER TABLE trades ADD COLUMN IF NOT EXISTS confirmation TEXT NOT NULL DEFAULT 'confirmed';

-- ---------------------------------------------------------------- tokens
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS decimals INTEGER;
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS graduation_signature TEXT;
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS graduated_at TIMESTAMPTZ;
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS pool_address TEXT;
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS decoder_version TEXT;

-- ------------------------------------------------------------- positions
ALTER TABLE positions ADD COLUMN IF NOT EXISTS quantity_raw TEXT;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS cost_basis_raw TEXT;

-- ---------------------------------------------------------- fee_events
ALTER TABLE fee_events ADD COLUMN IF NOT EXISTS decoder_version TEXT;
ALTER TABLE fee_events ADD COLUMN IF NOT EXISTS amount_raw TEXT;
ALTER TABLE fee_events ADD COLUMN IF NOT EXISTS amount_decimals INTEGER;
-- Creator-fee claims pool across a creator's coins: mint may be unknown.
-- UNKNOWN ≠ ZERO: a NULL mint means "not attributable to one mint".
ALTER TABLE fee_events ALTER COLUMN mint DROP NOT NULL;
ALTER TABLE fee_events ALTER COLUMN recipient DROP NOT NULL;
-- Idempotency: the (trade_signature, fee_type, recipient) unique key cannot
-- deduplicate NULL recipients (Postgres treats NULLs as distinct), so replays
-- would duplicate cashback/buyback/network rows. dedupe_key is a deterministic
-- sha256 of the event's identity, computed by the indexer — NULL-safe.
ALTER TABLE fee_events ADD COLUMN IF NOT EXISTS event_index INTEGER;
ALTER TABLE fee_events ADD COLUMN IF NOT EXISTS dedupe_key TEXT;
UPDATE fee_events
SET dedupe_key = md5(trade_signature || '|' || fee_type || '|' || COALESCE(recipient, '') || '|' || COALESCE(amount_raw, amount::text))
WHERE dedupe_key IS NULL AND trade_signature IS NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fee_events_dedupe_key_unique') THEN
    ALTER TABLE fee_events ADD CONSTRAINT fee_events_dedupe_key_unique UNIQUE (dedupe_key);
  END IF;
END $$;

-- --------------------------------------------------------------- cards
-- Exact card metrics (rational strings); legacy DOUBLE columns stay as
-- best-effort approximations.
ALTER TABLE cards ADD COLUMN IF NOT EXISTS multiple_raw TEXT;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS return_pct_raw TEXT;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS qualifying_entry_usd_raw TEXT;

-- ------------------------------------------------------------ amm_pools
CREATE TABLE IF NOT EXISTS amm_pools (
  pool            TEXT PRIMARY KEY,
  base_mint       TEXT NOT NULL,
  quote_mint      TEXT NOT NULL,
  base_decimals   INTEGER,
  quote_decimals  INTEGER,
  creator         TEXT,
  coin_creator    TEXT,
  created_slot    BIGINT,
  created_at      TIMESTAMPTZ,
  decoder_version TEXT,
  first_seen_sig  TEXT
);
CREATE INDEX IF NOT EXISTS idx_amm_pools_base_mint ON amm_pools(base_mint);

-- ------------------------------------------------------ decode_failures
CREATE TABLE IF NOT EXISTS decode_failures (
  id              BIGSERIAL PRIMARY KEY,
  signature       TEXT NOT NULL,
  event_index     INTEGER,
  job             TEXT NOT NULL,
  stage           TEXT NOT NULL,
  error           TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  resolved        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (signature, event_index, stage)
);
CREATE INDEX IF NOT EXISTS idx_decode_failures_unresolved ON decode_failures(resolved) WHERE resolved = FALSE;

-- -------------------------------------------------------- indexer_stats
CREATE TABLE IF NOT EXISTS indexer_stats (
  job               TEXT PRIMARY KEY,
  last_cycle_at     TIMESTAMPTZ,
  txs_seen          BIGINT NOT NULL DEFAULT 0,
  txs_decoded       BIGINT NOT NULL DEFAULT 0,
  txs_skipped_failed BIGINT NOT NULL DEFAULT 0,
  events_decoded    BIGINT NOT NULL DEFAULT 0,
  events_failed     BIGINT NOT NULL DEFAULT 0,
  last_error        TEXT,
  decoder_version   TEXT
);
