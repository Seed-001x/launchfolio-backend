// src/indexer/prices.js — USD-per-pair-unit lookups for the settle pipeline.
//
// The card engine's $10 qualifying-entry threshold needs entry value in USD.
// We resolve USD per WHOLE pair unit:
//   SOL  -> CoinGecko simple/price, cached 10 minutes in price_cache.
//   USDC -> exactly 1.
//   anything else -> null (unknown; the engine then refuses to qualify,
//                    per "unknown = null, never guess").
//
// Only used for the dust filter and display estimates — never for on-chain
// accounting, which stays in exact raw pair units.

import { fromDecimalString } from '../engines/money.js';

const TTL_MS = 10 * 60 * 1000;

async function cachedUsd(pool, asset) {
  const { rows } = await pool.query(
    'SELECT usd, fetched_at FROM price_cache WHERE asset = $1',
    [asset]
  );
  if (rows.length && Date.now() - new Date(rows[0].fetched_at).getTime() < TTL_MS) {
    return rows[0].usd;
  }
  return null;
}

async function fetchSolUsd() {
  const res = await fetch(
    'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
    { signal: AbortSignal.timeout(15000) }
  );
  if (!res.ok) throw new Error(`coingecko ${res.status}`);
  const j = await res.json();
  const usd = j?.solana?.usd;
  if (typeof usd !== 'number' || !(usd > 0)) throw new Error('coingecko bad payload');
  return usd;
}

/**
 * @returns exact rational (USD per whole pair unit) or null when unknown.
 * Also returns the double used, for auditability.
 */
export async function usdPerPairUnit(pool, pairAsset) {
  const asset = (pairAsset || 'SOL').toUpperCase();
  if (asset === 'USDC' || asset === 'USD') {
    return { rat: fromDecimalString('1'), usd: 1, asset };
  }
  if (asset !== 'SOL') return null;
  const hit = await cachedUsd(pool, 'SOL');
  if (hit !== null) return { rat: fromDecimalString(String(hit)), usd: hit, asset };
  const usd = await fetchSolUsd();
  await pool.query(
    `INSERT INTO price_cache (asset, usd, fetched_at) VALUES ('SOL', $1, now())
     ON CONFLICT (asset) DO UPDATE SET usd = EXCLUDED.usd, fetched_at = now()`,
    [usd]
  );
  return { rat: fromDecimalString(String(usd)), usd, asset };
}
