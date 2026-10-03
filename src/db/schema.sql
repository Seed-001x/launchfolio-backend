-- launchfolio-backend schema — v1
-- Run with: npm run db:migrate   (or: psql $DATABASE_URL -f src/db/schema.sql)
--
-- Security / honesty rules baked into the schema:
--   * No private keys, seed phrases, or wallet secrets are stored anywhere.
--   * UNKNOWN values are NULLABLE, never 0.  (UNKNOWN != 0)
--   * launch_origin may only be 'LAUNCHFOLIO' when a verified launch record
--     exists in launch_records; it is never inferred from Pump presence.
--   * Trades are idempotent on (signature, event_index) so indexer reruns
--     are no-ops.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------- users
-- A Launchfolio account. Multi-wallet ready by design: a user links one or
-- more verified wallets; "user" is never rigidly "wallet address".
CREATE TABLE IF NOT EXISTS users (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  handle     TEXT UNIQUE,                    -- display name, optional
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- wallets
-- Verified wallet links. Verification means the server proved ownership via
-- a signed SIGN IN TO LAUNCHFOLIO message (see src/auth/wallet.js).
CREATE TABLE IF NOT EXISTS wallets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pubkey          TEXT NOT NULL UNIQUE,      -- base58 Solana address
  is_primary      BOOLEAN NOT NULL DEFAULT false,
  verified_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_method TEXT NOT NULL DEFAULT 'signed_message',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wallets_user ON wallets(user_id);

-- ---------------------------------------------------------------- launch_records
-- Proof that a token was launched THROUGH Launchfolio. The ONLY authority
-- for launch_origin = 'LAUNCHFOLIO'. Tokens on Pump without a row here are
-- EXTERNAL_PUMP, full stop.
CREATE TABLE IF NOT EXISTS launch_records (
  mint            TEXT PRIMARY KEY,          -- base58 token mint
  launch_signature TEXT NOT NULL,            -- tx that created the token
  launcher_wallet TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- tokens
-- Canonical Launchfolio Token model. Market fields are NULLABLE: an unknown
-- price/mcap is NULL (displayed as "unavailable"), never 0, never fabricated.
CREATE TABLE IF NOT EXISTS tokens (
  mint             TEXT PRIMARY KEY,
  name             TEXT,
  ticker           TEXT,
  image_url        TEXT,
  description      TEXT,
  creator_wallet   TEXT,
  created_at       TIMESTAMPTZ,               -- on-chain creation time, nullable if unknown
  launch_provider  TEXT NOT NULL DEFAULT 'pump',
  launch_origin    TEXT NOT NULL DEFAULT 'EXTERNAL_PUMP'
                     CHECK (launch_origin IN ('LAUNCHFOLIO', 'EXTERNAL_PUMP')),
  price            DOUBLE PRECISION,          -- SOL per token
  mcap             DOUBLE PRECISION,          -- SOL
  volume_24h       DOUBLE PRECISION,
  liquidity        DOUBLE PRECISION,
  holder_count     INTEGER,
  launch_state     TEXT,                      -- e.g. 'bonding', 'graduated'
  graduation_state TEXT,
  pair_asset       TEXT NOT NULL DEFAULT 'SOL',
  socials          JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_updated_at  TIMESTAMPTZ,               -- when market fields were last refreshed
  indexed_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tokens_origin  ON tokens(launch_origin);
CREATE INDEX IF NOT EXISTS idx_tokens_state   ON tokens(launch_state);
CREATE INDEX IF NOT EXISTS idx_tokens_ticker  ON tokens(ticker);
CREATE INDEX IF NOT EXISTS idx_tokens_creator ON tokens(creator_wallet);
CREATE INDEX IF NOT EXISTS idx_tokens_updated ON tokens(last_updated_at);

-- ---------------------------------------------------------------- trades
-- Verified on-chain trades, normalized into Launchfolio's Trade model.
-- Idempotency: (signature, event_index) is unique; ON CONFLICT DO NOTHING.
-- mcap_at_execution is NULL when it cannot be reliably reconstructed —
-- we never invent historical market caps.
CREATE TABLE IF NOT EXISTS trades (
  id               BIGSERIAL PRIMARY KEY,
  signature        TEXT NOT NULL,
  event_index      INTEGER NOT NULL DEFAULT 0,
  wallet           TEXT NOT NULL,
  mint             TEXT NOT NULL REFERENCES tokens(mint) ON DELETE CASCADE,
  side             TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  token_amount     DOUBLE PRECISION NOT NULL,
  pair_amount      DOUBLE PRECISION NOT NULL, -- SOL (lamports converted at ingest)
  usd_estimate     DOUBLE PRECISION,
  execution_price  DOUBLE PRECISION,
  mcap_at_execution DOUBLE PRECISION,        -- nullable: only when reliably known
  slot             BIGINT,
  block_time       TIMESTAMPTZ,
  confirmation     TEXT NOT NULL DEFAULT 'observed'
                     CHECK (confirmation IN ('observed', 'confirmed', 'finalized')),
  indexed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (signature, event_index)
);
CREATE INDEX IF NOT EXISTS idx_trades_wallet_mint ON trades(wallet, mint);
CREATE INDEX IF NOT EXISTS idx_trades_mint_time   ON trades(mint, block_time DESC);
CREATE INDEX IF NOT EXISTS idx_trades_sig         ON trades(signature);

-- ---------------------------------------------------------------- transfers
-- Token transfers. NEVER interpreted as trades — tracked separately and
-- only used to flag cost-basis uncertainty in positions.
CREATE TABLE IF NOT EXISTS transfers (
  id         BIGSERIAL PRIMARY KEY,
  wallet     TEXT NOT NULL,
  mint       TEXT NOT NULL REFERENCES tokens(mint) ON DELETE CASCADE,
  direction  TEXT NOT NULL CHECK (direction IN ('IN', 'OUT')),
  amount     DOUBLE PRECISION NOT NULL,
  signature  TEXT NOT NULL,
  block_time TIMESTAMPTZ,
  indexed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (signature, wallet, mint, direction)
);
CREATE INDEX IF NOT EXISTS idx_transfers_wallet_mint ON transfers(wallet, mint);

-- ---------------------------------------------------------------- positions
-- Reconstructed by PositionEngine (src/engines/positions.js) from verified
-- trades ONLY. cost_basis_uncertain = true when transfers touched the
-- position — we flag, never fabricate an entry price.
CREATE TABLE IF NOT EXISTS positions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet              TEXT NOT NULL,
  mint                TEXT NOT NULL REFERENCES tokens(mint) ON DELETE CASCADE,
  quantity            DOUBLE PRECISION NOT NULL DEFAULT 0,
  cost_basis          DOUBLE PRECISION,          -- weighted-average entry, SOL per token
  cost_basis_method   TEXT NOT NULL DEFAULT 'weighted_average',
  cost_basis_uncertain BOOLEAN NOT NULL DEFAULT false,
  realized_pnl        DOUBLE PRECISION NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (wallet, mint)
);
CREATE INDEX IF NOT EXISTS idx_positions_wallet ON positions(wallet);

-- ---------------------------------------------------------------- cards
-- Launchfolio Cards generated from VERIFIED trade history, with provenance.
-- verified = true only when every input came from on-chain data.
CREATE TABLE IF NOT EXISTS cards (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet              TEXT NOT NULL,
  mint                TEXT NOT NULL REFERENCES tokens(mint) ON DELETE CASCADE,
  position_id         UUID REFERENCES positions(id),
  entry_mcap          DOUBLE PRECISION,
  exit_mcap           DOUBLE PRECISION,
  return_pct          DOUBLE PRECISION,
  multiple            DOUBLE PRECISION,
  hold_duration_s     BIGINT,
  ath_after_entry     DOUBLE PRECISION,        -- nullable: only when reliably known
  qualifying_entry_usd DOUBLE PRECISION NOT NULL,
  trades              JSONB NOT NULL DEFAULT '[]'::jsonb,  -- tx signatures
  calculation_version TEXT NOT NULL,
  verified            BOOLEAN NOT NULL DEFAULT false,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (wallet, mint, position_id)
);
CREATE INDEX IF NOT EXISTS idx_cards_wallet ON cards(wallet);

-- ---------------------------------------------------------------- xp_events
-- Append-only XP ledger. event_id is deterministic (hash of source event),
-- so re-ingestion is a no-op via ON CONFLICT DO NOTHING.
CREATE TABLE IF NOT EXISTS xp_events (
  event_id            TEXT PRIMARY KEY,        -- deterministic: sha256(source_type:source_ref:reason)
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount              INTEGER NOT NULL,
  reason              TEXT NOT NULL,
  token_mint          TEXT,
  source_event        TEXT NOT NULL,           -- e.g. card id / trade signature
  calculation_version TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_xp_user ON xp_events(user_id);

-- ---------------------------------------------------------------- achievements
CREATE TABLE IF NOT EXISTS achievements (
  id          TEXT PRIMARY KEY,                -- e.g. 'first_card', 'ten_bagger'
  name        TEXT NOT NULL,
  description TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_achievements (
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  achievement_id TEXT NOT NULL REFERENCES achievements(id),
  awarded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  source         TEXT NOT NULL,                 -- 'verified' or 'demo'; never award
                                               -- performance achievements from demo
  PRIMARY KEY (user_id, achievement_id)
);

-- ---------------------------------------------------------------- binder_snapshots
-- Historical qualification snapshots so Launchfolio can explain WHY a token
-- qualified. Formula inputs are Launchfolio-controlled (src/engines/binder.js).
CREATE TABLE IF NOT EXISTS binder_snapshots (
  id                 BIGSERIAL PRIMARY KEY,
  mint               TEXT NOT NULL REFERENCES tokens(mint) ON DELETE CASCADE,
  taken_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  holder_count       INTEGER,
  unique_traders     INTEGER,
  volume             DOUBLE PRECISION,
  liquidity          DOUBLE PRECISION,
  age_s              BIGINT,
  holder_concentration DOUBLE PRECISION,
  qualification_pct  DOUBLE PRECISION,
  passed_criteria    JSONB NOT NULL DEFAULT '[]'::jsonb,
  UNIQUE (mint, taken_at)
);
CREATE INDEX IF NOT EXISTS idx_binder_mint_time ON binder_snapshots(mint, taken_at DESC);

-- ---------------------------------------------------------------- fee_events
-- ACCOUNTING ONLY. Tracks fee events for Launchfolio-origin tokens so the
-- economy dashboard can show verified values. No payout/buyback execution
-- lives here or anywhere in this backend — that is a future, separate step.
CREATE TABLE IF NOT EXISTS fee_events (
  id                    BIGSERIAL PRIMARY KEY,
  mint                  TEXT NOT NULL REFERENCES tokens(mint) ON DELETE CASCADE,
  trade_signature       TEXT NOT NULL,
  fee_type              TEXT NOT NULL,         -- e.g. 'creator_fee', 'protocol_fee'
  amount                DOUBLE PRECISION NOT NULL,
  recipient             TEXT NOT NULL,
  provider              TEXT NOT NULL DEFAULT 'pump',
  launchfolio_allocation DOUBLE PRECISION,    -- Launchfolio-controlled share, nullable if unknown
  block_time            TIMESTAMPTZ,
  indexed_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (trade_signature, fee_type, recipient)
);
CREATE INDEX IF NOT EXISTS idx_fee_mint ON fee_events(mint);

-- ---------------------------------------------------------------- auth_nonces
-- Sign-in-with-wallet nonces. Single-use, expiring. The signed message is
-- always exactly "SIGN IN TO LAUNCHFOLIO\n<nonce>" — no funds move.
CREATE TABLE IF NOT EXISTS auth_nonces (
  pubkey     TEXT PRIMARY KEY,
  nonce      TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used       BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- indexer_checkpoints
-- Resume/backfill state per indexer job. A stopped indexer resumes from
-- last_slot / last_signature; it never reprocesses or loses history.
CREATE TABLE IF NOT EXISTS indexer_checkpoints (
  job_name       TEXT PRIMARY KEY,
  last_slot      BIGINT,
  last_signature TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
