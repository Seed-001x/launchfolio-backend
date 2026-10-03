# Launchfolio Backend

The server-backed data foundation for Launchfolio — real verified Solana + Pump
data powering tokens, trades, positions, cards, XP, leaderboards, binder metrics,
and fee accounting.

The static `launchfolio` artifact stays as the **Demo Mode prototype** (mock data,
runs anywhere). This backend is the production path: it indexes real on-chain
activity and serves it to the frontend as verified data. Demo and verified data
are never mixed.

## Architecture

```
                    ┌─────────────────────┐
                    │   Solana / Pump     │
                    │  (pump.fun program) │
                    └─────────┬───────────┘
                              │  getSignaturesForAddress (polling MVP)
                              ▼
                    ┌─────────────────────┐
                    │  src/indexer/pump.js│  idempotent · retryable ·
                    │  (background worker)│  checkpointed · safe to rerun
                    └─────────┬───────────┘
                              │  normalized rows
                              ▼
                    ┌─────────────────────┐
                    │      Postgres       │  tokens · trades · transfers ·
                    │   src/db/schema.sql │  positions · cards · xp_events ·
                    └─────────┬───────────┘  binder_snapshots · fee_events
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
     src/engines/    src/auth/wallet.js   src/api/server.js
     positions ·     sign-in with wallet  Express REST API
     cards · xp ·    (ed25519, JWT)       verified reads only
     trending ·
     binder
```

**Trust boundary:** the client is never trusted for wallet ownership, PnL, XP,
cards, leaderboard scores, fee accounting, or binder qualification. All derived
values are computed server-side by the engines from indexed on-chain data.
Private keys / seed phrases are never accepted or stored anywhere.

## What's here

| Path | Purpose |
|---|---|
| `src/db/schema.sql` | Full Postgres schema (14 tables). `UNKNOWN ≠ 0`: market fields nullable. `launch_origin` only `LAUNCHFOLIO` with a verified `launch_records` row. |
| `src/db/pool.js`, `src/db/migrate.js` | pg pool + `npm run db:migrate` runner. |
| `src/indexer/pump.js` | Polling indexer for the Pump program. Checkpoint resume, per-signature error isolation, idempotent inserts. |
| `src/engines/positions.js` | PositionEngine: weighted-average cost basis (matches Demo Mode trading), transfers never treated as trades, uncertain basis flagged not fabricated. |
| `src/engines/cards.js` | CardEngine: $10 minimum qualifying entry, full provenance, `verified` flag. |
| `src/engines/xp.js` | XPEngine: deterministic event IDs — re-ingestion is a no-op. |
| `src/engines/trending.js` | TrendingEngine: configurable weights (unique traders weighted over raw volume). |
| `src/engines/binder.js` | BinderMetrics: Launchfolio-controlled qualification formula + snapshots. |
| `src/auth/wallet.js` | `POST /auth/nonce` → sign `SIGN IN TO LAUNCHFOLIO\n<nonce>` → `POST /auth/verify` → JWT session. Multi-wallet ready. |
| `src/api/server.js` | Express API: tokens, trades, candles (real buckets only), holders, portfolio, positions, cards, verified leaderboard, creators, fee accounting, health. |

## Local dev setup

```bash
cd ~/workspace/launchfolio-backend
npm install

# 1. Start Postgres (local or hosted) and point at it:
cp .env.example .env
# edit .env: DATABASE_URL, RPC_URL (devnet is fine), JWT_SECRET

# 2. Create the schema:
npm run db:migrate

# 3. Run the API + indexer (two terminals):
npm run api       # REST API on :3000
npm run indexer   # Pump program indexer (background loop)
```

Smoke-test the pure engines without a database (23 assertions):

```bash
node /tmp/engine-test.mjs   # requires the backend dir in place
```

## Deploy

### Render (render.yaml included)

1. Push this directory to a git repo.
2. In Render: **New → Blueprint**, point at the repo. The blueprint creates:
   - `launchfolio-api` web service (Docker, health check on `/health`)
   - `launchfolio-indexer` background worker (same image, `node src/indexer/pump.js`)
   - `launchfolio-db` Postgres, wired into both as `DATABASE_URL`
3. Set `RPC_URL` (Helius recommended for production) in the Render dashboard.
   `JWT_SECRET` is generated automatically.
4. After first deploy, run the migration once:
   Render Shell on the API service → `npm run db:migrate`.

### Railway / VPS

- Railway: create a Postgres plugin + a service from this repo; set the same
  env vars; run `npm run db:migrate` once; run the indexer as a second service
  with start command `node src/indexer/pump.js`.
- VPS: `docker build -t launchfolio .` then run two containers (API + indexer)
  against a managed Postgres; or run bare-metal with Node 20+ and pm2.

## Env vars

| Var | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string |
| `JWT_SECRET` | yes | Long random string for session signing |
| `RPC_URL` | yes for prod | Helius recommended; devnet OK for testing |
| `PORT` | no | Default 3000 |
| `PROGRAM_ID` | no | Pump program to index (default: pump.fun) |
| `POLL_INTERVAL_MS` | no | Indexer poll interval, default 15000 |

## PUMP INDEXER — decode upgrade (implemented)

### Implemented

- **Anchor event decoding (no guessing):** `src/indexer/decoders/` decodes
  `TradeEvent` (both current and legacy 16-byte-shorter layouts), `CreateEvent`,
  `CompleteEvent`, `CompletePumpAmmMigrationEvent` from the Pump bonding-curve
  program, and `BuyEvent`/`SellEvent`/`CreatePoolEvent`/
  `CollectCoinCreatorFeeEvent` from the PumpSwap AMM program. Layouts are
  verbatim from `@pump-fun/pump-sdk` v2.0.0's vendored IDL; the TradeEvent
  layout was verified byte-for-byte against a real mainnet buy.
- **Exact amounts:** every amount is a raw on-chain integer (`u64` → BigInt in
  memory, decimal string in storage). BUY `pair_amount` = the user's total
  spend (gross); SELL `pair_amount` = net proceeds — verified from the SDK's
  fee math. Fee breakdown (protocol/creator/LP/cashback/buyback/holder
  rewards) is decoded exactly per trade for accounting. **No payouts,
  buybacks, or fee distribution code exists.**
- **Modular decoders:** `PumpBondingDecoder` (`pump-bonding-v1`) and
  `PumpSwapDecoder` (`pumpswap-v1`) both emit one canonical
  `NormalizedTrade` (`src/indexer/decoders/normalized.js`) — the only shapes
  downstream code may touch. Every row carries `decoder_version`.
- **Decimals:** resolved per mint from the mint account (byte 44, works for
  Token + Token-2022), the AMM `CreatePoolEvent`, or the DB cache — in that
  order. Unresolvable stays `NULL`; never guessed.
- **Launch + graduation:** `CreateEvent` → token row; migration/complete
  events → `BONDING → GRADUATED` update (never a duplicate row).
  `launch_origin` becomes `LAUNCHFOLIO` only when a `launch_records` row
  proves it — the indexer can never set it from chain data.
- **Robustness:** inner (CPI) instructions attributed via log-frame tracking;
  multi-event txs get per-event indices; legacy + v0 transaction messages;
  failed transactions (`meta.err`) excluded from all economic state;
  idempotent on `(signature, event_index)`; confirmation lifecycle
  observed → confirmed → finalized; decode failures go to the
  `decode_failures` retry queue (never silent); `npm run reconcile`
  re-decodes a slot range and diffs it against the DB.
- **Exact engines:** `PositionEngine` (`positions/v2`), `CardEngine`
  (`cards/v2`), and `XPEngine` (`xp/v2`) run on exact BigInt/rational math
  (`src/engines/money.js`) — same methodology, zero float error. Legacy
  double columns remain as documented non-authoritative approximations.
- **Health:** `/health` now reports per-job `indexer_stats`, unresolved
  decode failures, trades missing decimals, and active decoder versions.

### STEP 12 — reconciliation, provenance, graduation boundary (implemented)

- **Per-trade balance reconciliation** (`src/indexer/reconcileTrade.js`,
  pure, runs inside `processTransaction` for every decoded trade): the
  trader's summed token-account delta must **exactly** equal
  ±`token_amount_raw` (tolerance 0), and the combined SOL + quote-token flow
  must equal ±`pair_amount_raw` minus the network fee (when the trader paid
  it) minus ATA rent per newly created token account (1,000-lamport dust
  tolerance; sells also test a rent-return hypothesis). WSOL-quoted
  (PumpSwap) trades sum SOL + WSOL deltas since wrapping is 1:1.
  Aggregator-routed trades (pump invoked via CPI) **skip** the SOL check with
  a documented reason — router economics are invisible to the decoder (the
  live mainnet fixture proves the divergence: 1,517,105,000 lamports moved
  vs 1,481,481,480 decoded). A mismatch never blocks or alters the trade
  (the program event is authoritative); it queues a `decode_failures` row
  (stage `reconcile:trade`) with expected-vs-observed detail and the raw tx
  meta preserved, and bumps `indexer_stats.reconcile_mismatches`.
- **Provenance audit** (additive migration `003_step12.sql`): trades now
  carry `program`, `ix_name`, `event_name`, plus exact
  `token_amount_normalized` / `pair_amount_normalized` decimal strings
  (money.js rational engine, never floats; NULL when decimals unknown);
  `decode_failures.raw_tx` (JSONB, written for reconcile flags only);
  `indexer_stats.reconcile_mismatches`. No backfill — existing rows keep
  NULL (unknown = null, never fabricated).
- **Graduation boundary fixes:** swap-first-seen mints are recorded as
  `graduated` (documented assumption: a PumpSwap pool trade implies the
  migration already closed the curve); `applyGraduation` is now keyed on
  `graduation_signature IS NULL` so an out-of-order migration event still
  backfills signature/time exactly once; `poolResolver` snapshots
  `amm_pools` into memory before the decode (it previously returned an
  async function into the synchronous decoder, so every swap trade failed
  pool resolution — caught by the new tests). The decoder still only knows
  the two Pump programs; this is not a generalized DEX indexer.
- **Standalone reconcile** (`npm run reconcile`) now also emits
  `balance-mismatch` entries from the same tripwire.
- Full verification report: `docs/STEP12-VERIFICATION.md` — including the
  **live replay** (the real fixture's signature re-fetched from mainnet RPC
  and decoded byte-identically, reconciliation clean) and explicit
  unsupported-transaction-type list.

### Tested

`npm test` (`node --test test/`) — **84/84 pass**. Borsh primitives, the
**real mainnet buy fixture** (`test/fixtures/tx_buy_real.json`, decoded to
exact verified values — and re-fetched live from mainnet RPC in STEP 12,
decoding byte-identically), all decoder paths (sells, creates, graduations,
multi-event, inner-instruction, failed-tx, legacy layout, v0, unknown
data/pool), orchestrator SQL patterns against a mock pool, engine
methodology baselines, a full lifecycle test (buy ≥$10 → buy → partial sell
→ exit → card → XP awarded exactly once; re-runs don't double-award), and
**16 reconciliation tests** (`test/reconcile.test.js`): reconciler unit
cases (exact buy/sell, rent hypotheses, token/SOL mismatches flagged, dust
boundary, routed-trade skip, unavailable-data honesty, WSOL summation, the
live mainnet buy) plus end-to-end coverage (clean fixtures silent, tampered
balances flagged with raw tx preserved while the trade is still stored,
duplicate replay idempotent, provenance/normalized columns, swap-first
graduation labeling + graduation backfill).

### Unresolved / known limits

- **Polling transport** remains the MVP; the production path is still Helius
  webhooks or a geyser/gRPC stream for scale.
- **Decimals backfill:** tokens indexed before this upgrade have
  `token_decimals = NULL` until reprocessed; legacy double columns for those
  rows are in raw units.
- **USD estimates / market caps** are never invented: `usd_estimate` and
  `mcap_at_execution` stay `NULL` without a price feed; endpoints report
  `stale: true` past 5 minutes.
- **Reconcile is operator-driven:** discrepancies are reported, never
  auto-fixed.

## Intentionally NOT built

- **Real trading execution** — no buy/sell transaction construction or signing.
- **Real launching** — no token creation transactions.
- **Leaderboard payouts, buybacks, fee distribution** — `fee_events` is
  accounting only; no settlement code exists.
- **Launchfolio token** — nothing here mints or manages one.
- **Private-key handling** — there is deliberately no code path that accepts,
  stores, or transmits secrets.

## What remains before the frontend rewires

1. Deploy API + indexer + Postgres (Render blueprint is ready).
2. Run `npm run db:migrate` against the production database.
3. ~~Implement the Anchor IDL decode upgrade~~ — DONE (see PUMP INDEXER above).
   Backfill: run the indexer over historical signatures for the tokens the
   frontend cares about, then `npm run reconcile` to verify.
5. Point the frontend at the API: replace mock data sources with
   `GET /tokens`, `/tokens/:mint/*`, `/wallets/:pubkey/*`, `/leaderboard?board=verified`.
   Keep the Demo Mode prototype untouched until the verified path is proven.
6. Wire wallet connection → `POST /auth/nonce` + `POST /auth/verify` for
   sign-in; keep Demo Mode's mock wallet as the fallback.
