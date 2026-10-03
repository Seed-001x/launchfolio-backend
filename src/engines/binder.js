// src/engines/binder.js — BinderMetrics
//
// METHODOLOGY:
//   * The Official Binder qualification formula is LAUNCHFOLIO-CONTROLLED.
//     These constants are the formula; changing qualification rules means
//     changing this file and bumping FORMULA_VERSION — never client input,
//     never ad-hoc SQL.
//   * Inputs come from indexed data only (holder counts, trade aggregates,
//     liquidity, age, concentration, graduation state). An input that is
//     unknown contributes 0 weight but is RECORDED as missing in the
//     snapshot's passed_criteria — never silently treated as passing.
//   * scoreToken returns { qualification_pct, passed_criteria } and the caller
//     persists a binder_snapshots row, so Launchfolio can always explain why
//     a token qualified.
//
// Weights sum to 1. Threshold: QUALIFICATION_THRESHOLD_PCT to earn a Genesis #.

export const FORMULA_VERSION = 'binder/v1';

export const BINDER_CRITERIA = {
  min_holder_count: { weight: 0.25, threshold: 500 },
  min_unique_traders_24h: { weight: 0.2, threshold: 200 },
  min_volume_24h_sol: { weight: 0.15, threshold: 100 },
  min_liquidity_sol: { weight: 0.1, threshold: 20 },
  min_age_hours: { weight: 0.1, threshold: 72 },
  max_holder_concentration: { weight: 0.1, threshold: 0.5 }, // top-10 share < 50%
  graduated: { weight: 0.1, threshold: true }, // boolean criterion
};

export const QUALIFICATION_THRESHOLD_PCT = 70;

/**
 * Score a token against the binder formula.
 *
 * @param {Object} m - indexed metrics:
 *   { holderCount, uniqueTraders24h, volume24hSol, liquiditySol,
 *     ageHours, top10Concentration, graduated }
 * @returns {{ qualification_pct, passed_criteria: string[] }}
 */
export function scoreToken(m) {
  const passed = [];
  let pct = 0;

  const check = (name, ok, weight) => {
    if (ok) {
      pct += weight * 100;
      passed.push(name);
    }
  };

  check('holder_count', (m.holderCount ?? -1) >= BINDER_CRITERIA.min_holder_count.threshold,
    BINDER_CRITERIA.min_holder_count.weight);
  check('unique_traders', (m.uniqueTraders24h ?? -1) >= BINDER_CRITERIA.min_unique_traders_24h.threshold,
    BINDER_CRITERIA.min_unique_traders_24h.weight);
  check('volume_24h', (m.volume24hSol ?? -1) >= BINDER_CRITERIA.min_volume_24h_sol.threshold,
    BINDER_CRITERIA.min_volume_24h_sol.weight);
  check('liquidity', (m.liquiditySol ?? -1) >= BINDER_CRITERIA.min_liquidity_sol.threshold,
    BINDER_CRITERIA.min_liquidity_sol.weight);
  check('age', (m.ageHours ?? -1) >= BINDER_CRITERIA.min_age_hours.threshold,
    BINDER_CRITERIA.min_age_hours.weight);
  check('distribution', (m.top10Concentration ?? 2) <= BINDER_CRITERIA.max_holder_concentration.threshold,
    BINDER_CRITERIA.max_holder_concentration.weight);
  check('graduated', m.graduated === true, BINDER_CRITERIA.graduated.weight);

  return { qualification_pct: Math.round(pct * 10) / 10, passed_criteria: passed };
}

/** True when a token earns a Genesis number under the current formula. */
export function qualifiesForGenesis(score) {
  return score.qualification_pct >= QUALIFICATION_THRESHOLD_PCT;
}
