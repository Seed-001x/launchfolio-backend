// src/engines/money.js — exact rational arithmetic for authoritative finance.
//
// RULE: no floating-point anywhere in the authoritative path. All on-chain
// amounts arrive as integers (lamports, raw token units); they stay integers
// (BigInt) through every calculation. Division produces an exact rational
// { n: BigInt, d: BigInt } with d > 0, reduced by gcd. Decimal strings are
// produced ONLY at the display/persistence edge, with documented rounding
// (round-half-up) and an explicit place count.
//
// A rational is a frozen { n, d }. d === 1n means an integer value.

function gcd(a, b) {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

/** Construct a reduced rational n/d. d must be nonzero. */
export function rat(n, d = 1n) {
  n = BigInt(n);
  d = BigInt(d);
  if (d === 0n) throw new RangeError('rational with zero denominator');
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  if (n === 0n) return Object.freeze({ n: 0n, d: 1n });
  const g = gcd(n, d);
  return Object.freeze({ n: n / g, d: d / g });
}

/** Integer → rational. */
export function fromInt(v) {
  return rat(BigInt(v), 1n);
}

/**
 * Raw on-chain integer + decimals → rational in whole units.
 * e.g. fromRawInt("1481481480", 9) === 1.48148148 exactly.
 */
export function fromRawInt(raw, decimals) {
  if (raw === null || raw === undefined) return null;
  if (decimals === null || decimals === undefined) return null;
  const d = Number(decimals);
  if (!Number.isInteger(d) || d < 0) return null;
  return rat(BigInt(String(raw)), 10n ** BigInt(d));
}

export const ZERO = Object.freeze({ n: 0n, d: 1n });
export const ONE = Object.freeze({ n: 1n, d: 1n });

export function isZero(r) {
  return r.n === 0n;
}

export function neg(r) {
  return rat(-r.n, r.d);
}

export function add(a, b) {
  return rat(a.n * b.d + b.n * a.d, a.d * b.d);
}

export function sub(a, b) {
  return rat(a.n * b.d - b.n * a.d, a.d * b.d);
}

export function mul(a, b) {
  return rat(a.n * b.n, a.d * b.d);
}

/** Exact division. Throws on division by zero (caller must guard). */
export function div(a, b) {
  if (b.n === 0n) throw new RangeError('division by zero rational');
  return rat(a.n * b.d, a.d * b.n);
}

/** Multiply a rational by a plain integer (BigInt-safe). */
export function mulInt(r, v) {
  return rat(r.n * BigInt(v), r.d);
}

/** Compare: -1, 0, 1. */
export function cmp(a, b) {
  const l = a.n * b.d;
  const r = b.n * a.d;
  return l < r ? -1 : l > r ? 1 : 0;
}

export function min(a, b) {
  return cmp(a, b) <= 0 ? a : b;
}

export function max(a, b) {
  return cmp(a, b) >= 0 ? a : b;
}

/**
 * Exact decimal expansion, round-half-up to `places` fractional digits.
 * Returns a string like "1.48148148" or "0" — never a Number.
 * Trailing zeros are trimmed (but at least one integer digit remains).
 */
export function toDecimalString(r, places = 18) {
  if (!Number.isInteger(places) || places < 0 || places > 60) {
    throw new RangeError('places must be an integer 0..60');
  }
  const neg_ = r.n < 0n;
  const n = neg_ ? -r.n : r.n;
  const scale = 10n ** BigInt(places);
  // Round-half-up: floor((n*scale*10/d + 5) / 10)
  const scaled10 = (n * scale * 10n) / r.d;
  const rounded = (scaled10 + 5n) / 10n;
  const intPart = rounded / scale;
  const fracPart = rounded % scale;
  let frac = fracPart.toString().padStart(places, '0').replace(/0+$/, '');
  const s = frac ? `${intPart.toString()}.${frac}` : intPart.toString();
  return neg_ && s !== '0' ? '-' + s : s;
}

/**
 * Parse a decimal string back to an exact rational. Used in tests and at
 * the API edge; on-chain values should prefer fromRawInt.
 */
export function fromDecimalString(s) {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(s).trim());
  if (!m) throw new RangeError(`not a decimal string: ${s}`);
  const frac = m[3] || '';
  const n = BigInt(m[1] + m[2] + frac);
  return rat(n, 10n ** BigInt(frac.length));
}

/** Floor a rational to a BigInt (toward negative infinity). */
export function floorToInt(r) {
  const q = r.n / r.d;
  // BigInt division truncates toward zero; adjust for negatives.
  if (r.n < 0n && r.n % r.d !== 0n) return q - 1n;
  return q;
}

/**
 * Exact rational serialization: "numerator/denominator" (e.g. "7/3", "12/1").
 * Round-trips through ratFromString with zero precision loss — the format
 * used for cost_basis_raw / realized_pnl_raw persistence.
 */
export function ratToString(r) {
  return `${r.n.toString()}/${r.d.toString()}`;
}

/** Parse a "n/d" string back to an exact rational. */
export function ratFromString(s) {
  const m = /^(-?\d+)\/(\d+)$/.exec(String(s).trim());
  if (!m) throw new RangeError(`not a rational string: ${s}`);
  return rat(BigInt(m[1]), BigInt(m[2]));
}
