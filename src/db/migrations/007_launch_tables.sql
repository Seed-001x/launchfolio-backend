-- 007_launch_tables.sql
--
-- Launch pipeline tables:
--   pair_registry  — pump.fun's on-chain quote-asset whitelist, mirrored here.
--                    Source of truth is on-chain (Global.whitelistedQuoteMints
--                    + the quote-control PDA); this table is a cache the
--                    frontend searches. Refreshed by the API on a schedule.
--   launch_intents — forge sessions between /prepare and /register. The
--                    unsigned tx is built from these params; /register reads
--                    them back to tag the token (origin, socials, pair).
--                    Short-lived; never a promise that a launch happened.

CREATE TABLE IF NOT EXISTS pair_registry (
  quote_mint   TEXT PRIMARY KEY,          -- base58 quote asset mint
  symbol       TEXT NOT NULL,             -- e.g. 'NVDAx'
  name         TEXT,                      -- e.g. 'Nvidia (xStocks)'
  decimals     INTEGER,
  logo_url     TEXT,
  source       TEXT NOT NULL DEFAULT 'global' CHECK (source IN ('sol', 'global', 'quote_control')),
  is_active    BOOLEAN NOT NULL DEFAULT true,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pair_registry_active ON pair_registry(is_active);

CREATE TABLE IF NOT EXISTS launch_intents (
  mint          TEXT PRIMARY KEY,          -- the client-generated mint pubkey
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  launcher_wallet TEXT NOT NULL,
  name          TEXT NOT NULL,
  symbol        TEXT NOT NULL,
  metadata_uri  TEXT NOT NULL,
  pair_mint     TEXT NOT NULL,             -- 'SOL' or a quote mint from pair_registry
  creator_fee_bps INTEGER NOT NULL DEFAULT 0,
  holder_reward BOOLEAN NOT NULL DEFAULT false,
  splits        JSONB NOT NULL DEFAULT '[]'::jsonb,  -- planned post-launch fee split
  socials       JSONB NOT NULL DEFAULT '{}'::jsonb,
  aura          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '15 minutes'
);
CREATE INDEX IF NOT EXISTS idx_launch_intents_expires ON launch_intents(expires_at);
