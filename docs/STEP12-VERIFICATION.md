# STEP 12 — Verification Report: Production Pump.fun Transaction Decoding

Date: 2026-09-29. Scope: gap-fill on the decode upgrade (Step 11 follow-up).
No deploy, no frontend rewire, no real trading — decode and verify only.

## 1. Live historical replay (REAL mainnet data)

A live replay WAS possible from the sandbox for a single transaction:

- The real mainnet buy in `test/fixtures/tx_buy_real.json` (signature
  `25KLghUYvKgGEPg2…`, slot 451641404) was **re-fetched live** via the public
  RPC (`solana-rpc.publicnode.com`, 11.4s) on 2026-09-29.
- The live-fetched transaction was decoded with the production decoders and
  compared field-by-field against the stored fixture decode: **every field
  matched** — side, wallet, mint, ix_name (`buy`), event_name (`TradeEvent`),
  token_amount_raw (29366330556388), pair_amount_raw (1481481480),
  fee_protocol_raw (14074075), fee_creator_raw (4444445), program id,
  decoder version (`pump-bonding-v1`).
- The **balance reconciler** was run against the LIVE transaction (not the
  fixture copy): token check `ok` (trader token delta matched the decoded
  amount to the unit), quote check `skipped` (aggregator-routed — see §3),
  overall `mismatch = false`.

A broader fresh-transaction sweep was attempted twice
(`getSignaturesForAddress` on the Pump program + `getTransaction` per tx):
the address-history RPC endpoint timed out from this sandbox both times
(25–45s timeouts; the sandbox's documented RPC flakiness). The sweep was
**not faked** — it is recorded here as not run. It should be re-run from the
production host with the Helius key before the frontend rewire.

## 2. Fixture-based verification (what the 84 tests prove)

`node --test "test/*.test.js"` — **84/84 pass** (68 pre-existing + 16 new
in `test/reconcile.test.js`).

- **Exact-value decode**: bonding buy/sell, legacy 16-byte-short TradeEvent,
  v0 transactions, multi-event (create+buy), inner-instruction (CPI) routing,
  PumpSwap buy/sell with pool attribution — all assert exact raw amounts.
- **New fixture gaps closed**: `bonding-tiny.json` (7,000 lamports /
  1,000 raw units → normalized `0.001` / `0.000007`), `bonding-unrelated.json`
  (unrelated System transfer in the same tx decodes cleanly), plus
  economically-consistent balance data on ALL trade fixtures (trader starts
  at 5B lamports, fee 5,000, ATA rent 2,039,280 per created account).
- **Duplicate replay**: processing the same transaction twice attempts the
  trade INSERT twice; `ON CONFLICT (signature, event_index) DO NOTHING`
  dedupes, reconciliation stays clean on both passes, zero failure rows.
- **Failed-tx exclusion**: `bonding-failed.json` produces no trades, no
  positions, no fee rows.
- **Unknown pool**: `amm-unknown-pool.json` → decode failure queued
  (`pool-resolution:BuyEvent`), mint never guessed.
- **Reconciler unit tests** (10): exact buy, sell-with-rent-return, token
  mismatch flagged, SOL mismatch flagged, dust boundary (1,000 lamports ok /
  1,001 flagged), routed-trade skip, missing balance data → `unavailable`
  (never a false pass), third-party fee payer, WSOL wrap/unwrap summation,
  and the real mainnet buy (token exact, quote skipped).
- **Reconciler integration tests** (6): clean fixtures reconcile silently;
  AMM fixtures pass the WSOL model; tampered balances queue a
  `reconcile:trade` failure with raw tx meta preserved while the trade is
  still stored; provenance + normalized columns land on the row; swap-first
  token labeling + graduation backfill (see §4).

## 3. Reconciliation design and tolerances

`src/indexer/reconcileTrade.js` — pure, runs inside `processTransaction`
for every decoded trade; needs no DB.

| Check | Rule | Tolerance |
|---|---|---|
| Base token | trader's summed token-account delta for the mint vs ±`token_amount_raw` | **0** — exact BigInt match |
| Quote side | combined trader SOL + quote-token flow vs ±`pair_amount_raw` − network fee (if trader paid it) − ATA rent per new trader token account; sells also test a +1-rent hypothesis (in-tx account close) | **1,000 lamports** dust |

- **Routed trades** (pump invoked via CPI, `inner_instruction_index > 0`):
  the quote check is `skipped` with a documented reason. Justification from
  the live tx: the trader's SOL delta (1,517,105,000) exceeded the decoded
  gross (1,481,481,480) by ~35.6M lamports — aggregator fees and rent the
  decoder cannot see. The token check still applies and matched exactly.
- **WSOL-quoted (PumpSwap) trades**: SOL and WSOL deltas are summed because
  wrapping is 1:1; pre-existing WSOL unwrapped in-tx cancels out. Verified
  against synthetic buy (wrap-then-spend) and sell (unwrap-all + close)
  fixtures.
- **On mismatch**: the trade is STILL inserted (the program event is
  authoritative — the flag is a tripwire, not a veto); a `decode_failures`
  row with stage `reconcile:trade` is queued carrying the expected-vs-observed
  detail AND `tx.meta` (balances, token balances, fee) in the new `raw_tx`
  column; `indexer_stats.reconcile_mismatches` increments. Nothing is
  silently swallowed.
- **Known blind spot**: a transaction containing two independent swaps will
  flag both trades (each is checked against the trader's tx-total movements).
  Correct tripwire behavior — needs analyst review, not silent acceptance.

## 4. Graduation boundary

- The bonding-curve and PumpSwap log walks are scoped to disjoint program-id
  sets (`{PUMP}` vs `{PUMP_AMM}`) — verified in code; a swap event can never
  be decoded as a bonding trade or vice versa. This is NOT a generalized DEX
  indexer: only the two Pump programs are decoded.
- Lifecycle is one row per mint: `BONDING → GRADUATED` in place, keyed on the
  authoritative `CompletePumpAmmMigrationEvent`.
- **Fixes in this step**:
  1. `applyGraduation` was keyed on the state label (`launch_state <>
     'graduated'`), which dropped a legitimately out-of-order migration event
     when the row had already been labeled `graduated` via its pool. It is
     now keyed on `graduation_signature IS NULL` — the event always backfills
     signature/time exactly once.
  2. Swap-first-seen mints (backfill starting after migration) previously got
     `launch_state='bonding'`. They are now recorded as `'graduated'` via
     `ensureTokenRowForSwap`, with the assumption documented in code: a
     PumpSwap pool trade implies the curve was migrated (migration closes the
     curve and creates the pool atomically). The graduation EVENT remains the
     authority for `graduation_signature`/`graduated_at`; an existing
     `'bonding'` row is upgraded by swap activity ONLY when a graduation
     signature is already on record. Edge case (permissionless non-migration
     pool for the same mint) is documented — `pool_address` disambiguates.
  3. `poolResolver` returned an **async** function into the **synchronous**
     decoder, so `resolvePool(e.pool)` yielded a Promise and EVERY swap trade
     through `processTransaction` failed with `unknown pool`. The resolver
     now snapshots `amm_pools` into a Map before the decode; the decoder
     stays pure/sync. (Caught by the new swap-first-seen test.)

## 5. Provenance audit (additive migration `003_step12.sql`)

| Column | Table | Content |
|---|---|---|
| `program` | trades | emitting program id (PUMP / PUMP_AMM) |
| `ix_name` | trades | program's instruction label (`buy`, `sell_v2`, …) |
| `event_name` | trades | `TradeEvent` / `BuyEvent` / `SellEvent` |
| `token_amount_normalized` | trades | exact decimal string (money.js rational engine, 18 places) |
| `pair_amount_normalized` | trades | exact decimal string |
| `raw_tx` | decode_failures | `tx.meta` JSON for `reconcile:trade` rows only |
| `reconcile_mismatches` | indexer_stats | tripwire counter (also in `/health`) |

Appended as params $21–$25 on the trade INSERT — existing param positions
untouched. No backfill: existing rows keep NULL (unknown = null, never
fabricated). No DB rebuild; `migrate.js` auto-discovers `003_step12.sql`.

## 6. Unsupported transaction types (explicit)

Not decoded (by design, each logged or skipped — never silently dropped):
- Non-Pump programs entirely (only `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`
  and `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` are decoded).
- Pump instructions without a recognized Anchor event log (e.g. bare
  transfers) — no `Program data:` event, nothing to decode.
- Unrecognized `Program data:` discriminators under the Pump programs —
  skipped, not failures (`unknown-data.json`).
- Failed transactions (`meta.err`) — excluded from all economic state.
- AMM trades for pools absent from `amm_pools` — decode failure queued,
  mint never guessed.
- Quote mints other than native SOL / WSOL — quote check `skipped` as
  unsupported (no such pools observed; tripwire stays honest).

## 7. Remaining limitations (honest)

1. Migration `003` is tested via mock-pool SQL-shape tests only — no
   Postgres in the sandbox. **Verify on deploy** (`migrate.js` runs it).
2. The fresh-transaction live sweep (§1) still needs a production-host run
   with the Helius key.
3. Polling indexer remains the MVP path; Helius webhooks are the production
   ingestion route (unchanged from the decode upgrade).
4. Multi-swap transactions flag reconciliation by design (§3) — needs an
   analyst runbook entry, not code.
5. The standalone `reconcile` script (`npm run reconcile`) now also emits
   `balance-mismatch` entries; it needs `RPC_URL` + `DATABASE_URL` and was
   not run here (no DB in sandbox).
