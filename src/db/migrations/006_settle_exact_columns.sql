-- 006_settle_exact_columns.sql
--
-- The engines compute exact-rational money math (quantity_raw, cost_basis_raw,
-- multiple_raw, ...), but the positions/cards tables only had legacy doubles.
-- Add the authoritative exact columns so the settle pipeline can persist them.
-- Also adds price_cache for the settle job's USD-per-pair-unit lookups
-- (CoinGecko, cached 10 min; USDC is exactly 1).

ALTER TABLE positions ADD COLUMN IF NOT EXISTS quantity_raw TEXT;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS cost_basis_raw TEXT;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS realized_pnl_raw TEXT;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS unrealized_pnl_raw TEXT;

ALTER TABLE cards ADD COLUMN IF NOT EXISTS return_pct_raw TEXT;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS multiple_raw TEXT;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS qualifying_entry_usd_raw TEXT;

CREATE TABLE IF NOT EXISTS price_cache (
  asset      TEXT PRIMARY KEY,          -- e.g. 'SOL', 'USDC'
  usd        DOUBLE PRECISION NOT NULL, -- USD per whole unit
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
