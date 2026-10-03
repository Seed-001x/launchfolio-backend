// src/engines/trending.js — TrendingEngine
//
// METHODOLOGY:
//   * "Trending" is a DEFINED, configurable formula — never raw volume alone
//     (that is trivially wash-tradable). Score blends:
//       - recent unique traders   (hardest to fake cheaply)
//       - recent volume
//       - trade velocity (trades per hour)
//       - holder growth
//       - price activity (absolute % move over the window)
//       - age penalty (newer tokens get a mild boost, decaying over 72h)
//   * Each input is normalized to [0,1] against rolling maxima supplied by
//     the caller (the indexer maintains these), then combined with WEIGHTS.
//   * Weights live in TRENDING_WEIGHTS and sum to 1. Tuning = editing the
//     config object, not the code path.
//   * Pure function; the API sorts tokens by the returned score.

export const TRENDING_WEIGHTS = {
  uniqueTraders: 0.3,
  volume: 0.2,
  tradeVelocity: 0.2,
  holderGrowth: 0.15,
  priceActivity: 0.1,
  ageBoost: 0.05,
};

export const TRENDING_WINDOW_HOURS = 24;
export const AGE_BOOST_HALF_LIFE_HOURS = 72;

const clamp01 = (x) => Math.min(1, Math.max(0, x));

/**
 * Score a token's trendiness over the trailing window.
 *
 * @param {Object} m - window metrics:
 *   { uniqueTraders, volumeSol, tradesPerHour, holderGrowthPct,
 *     priceMovePct, ageHours }
 * @param {Object} maxima - rolling maxima for normalization:
 *   { uniqueTraders, volumeSol, tradesPerHour } (holderGrowth/priceMove are
 *   self-normalizing percentages)
 * @param {Object} weights - optional override of TRENDING_WEIGHTS
 * @returns {number} score in [0,1]
 */
export function trendingScore(m, maxima, weights = TRENDING_WEIGHTS) {
  const norm = {
    uniqueTraders: clamp01(m.uniqueTraders / Math.max(1, maxima.uniqueTraders)),
    volume: clamp01(m.volumeSol / Math.max(1e-9, maxima.volumeSol)),
    tradeVelocity: clamp01(m.tradesPerHour / Math.max(1e-9, maxima.tradesPerHour)),
    holderGrowth: clamp01(m.holderGrowthPct / 100),
    priceActivity: clamp01(Math.abs(m.priceMovePct) / 100),
    // Newer tokens get a small boost that decays with a 72h half-life.
    ageBoost: Math.pow(0.5, (m.ageHours ?? 0) / AGE_BOOST_HALF_LIFE_HOURS),
  };
  return (
    norm.uniqueTraders * weights.uniqueTraders +
    norm.volume * weights.volume +
    norm.tradeVelocity * weights.tradeVelocity +
    norm.holderGrowth * weights.holderGrowth +
    norm.priceActivity * weights.priceActivity +
    norm.ageBoost * weights.ageBoost
  );
}
