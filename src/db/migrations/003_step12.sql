-- 003_step12.sql — STEP 12 provenance + reconciliation columns (additive only).
--
-- No tables are rebuilt and no data is backfilled here: existing rows keep
-- their values and new columns default to NULL (unknown = null, never
-- fabricated). The indexer populates these for newly processed trades.
--
--   trades.program / ix_name / event_name
--       Full decode provenance: which program emitted the event and which
--       instruction/event decoded it. (decoder_version already existed;
--       these close the remaining provenance gaps.)
--   trades.token_amount_normalized / pair_amount_normalized
--       Exact decimal strings for the raw amounts (computed with the exact
--       rational money engine, never floats). NULL when decimals are
--       unknown — the raw BigInt strings remain authoritative.
--   decode_failures.raw_tx
--       Investigation material for flagged trades: the reconciler stores
--       tx.meta (balances, token balances, logs, fee) here when a trade's
--       decoded amounts diverge from on-chain movements. Only written for
--       failures, never for clean trades.
--   indexer_stats.reconcile_mismatches
--       Counter for reconciliation tripwire hits (stage 'reconcile:trade').

ALTER TABLE trades ADD COLUMN IF NOT EXISTS program TEXT;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS ix_name TEXT;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS event_name TEXT;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS token_amount_normalized TEXT;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS pair_amount_normalized TEXT;

ALTER TABLE decode_failures ADD COLUMN IF NOT EXISTS raw_tx JSONB;

ALTER TABLE indexer_stats ADD COLUMN IF NOT EXISTS reconcile_mismatches BIGINT NOT NULL DEFAULT 0;
