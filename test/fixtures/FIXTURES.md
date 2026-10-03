# Test fixtures

## Real mainnet fixture

- `tx_buy_real.json`: real Pump bonding-curve BUY fetched from mainnet via
  public RPC on 2026-09-29. Routed through an aggregator (inner instruction).
  Verified decode: sol_amount=1481481480 lamports (1.48148148 SOL),
  token_amount=29366330556388, is_buy=true, ix_name="buy", fee=14074075
  (95 bps), creator_fee=4444445 (30 bps). The user's wallet balance delta
  (1,517,105,000 lamports) exceeds sol_amount+fees because of aggregator
  fees/ATA rent — which is exactly why event amounts (not balance deltas)
  are authoritative.

## Synthetic fixtures

Built by `build.js` with the REAL Anchor discriminators and Borsh field
order from `src/indexer/decoders/layouts.js` (the TradeEvent layout was
verified byte-for-byte against the real tx above). They are structurally
identical to mainnet transactions for the paths they exercise.

| file | exercises |
|---|---|
| bonding-buy.json | top-level buy decode, exact amounts |
| bonding-sell.json | sell decode (net proceeds semantics) |
| bonding-tiny.json | dust-scale amounts (7,000 lamports / 1,000 raw units) |
| bonding-unrelated.json | unrelated System transfer in the same tx |
| bonding-create.json | launch detection |
| bonding-graduation.json | migration event + AMM pool creation |
| bonding-multi.json | two events in one tx (create+buy), per-event index |
| bonding-inner.json | inner-instruction (CPI) attribution via router |
| bonding-failed.json | failed tx exclusion (meta.err) |
| bonding-legacy-trade.json | 16-byte-shorter legacy TradeEvent (zero-pad path) |
| amm-buy.json / amm-sell.json | PumpSwap trade decode with pool attribution |
| amm-unknown-pool.json | unknown pool → decode failure, mint never guessed |
| v0-tx.json | versioned (v0) transaction message shape |
| unknown-data.json | unrecognized Program data → skipped, not a failure |

## Balance modeling (STEP 12)

Trade fixtures carry economically CONSISTENT balance data
(`preBalances`/`postBalances` per account index plus`pre/postTokenBalances`)
so the balance reconciler (`src/indexer/reconcileTrade.js`) can be
exercised end-to-end. Conventions: the trader (account 0, fee payer)
starts at 5,000,000,000 lamports, `meta.fee` = 5,000, and each token
account created in-tx costs 2,039,280 lamports of ATA rent. Aggregator-
routed fixtures (e.g. `bonding-inner`) intentionally model only the
token side exactly — the SOL side is skipped by design.
