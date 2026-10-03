// test/money.test.js — exact rational arithmetic (src/engines/money.js).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  rat, fromInt, fromRawInt, fromDecimalString, add, sub, mul, div, cmp,
  toDecimalString, ratToString, ratFromString, floorToInt, ZERO,
} from '../src/engines/money.js';

describe('money: exact rational arithmetic', () => {
  it('reduces fractions and normalizes sign', () => {
    assert.deepEqual(rat(6n, 8n), { n: 3n, d: 4n });
    assert.deepEqual(rat(-6n, 8n), { n: -3n, d: 4n });
    assert.deepEqual(rat(6n, -8n), { n: -3n, d: 4n });
    assert.deepEqual(rat(0n, 5n), { n: 0n, d: 1n });
  });

  it('rejects zero denominator', () => {
    assert.throws(() => rat(1n, 0n), RangeError);
  });

  it('adds/subtracts/m multiplies/divides exactly (no float error)', () => {
    // 0.1 + 0.2 === 0.3 exactly — the classic float failure.
    const sum = add(fromDecimalString('0.1'), fromDecimalString('0.2'));
    assert.equal(sum.n, 3n);
    assert.equal(sum.d, 10n);
    // 1/3 * 3 === 1
    assert.deepEqual(mul(div(fromInt(1), fromInt(3)), fromInt(3)), { n: 1n, d: 1n });
    // 7/3 - 4/3 = 1
    assert.deepEqual(sub(rat(7n, 3n), rat(4n, 3n)), { n: 1n, d: 1n });
  });

  it('compares rationals without float conversion', () => {
    assert.equal(cmp(rat(1n, 3n), rat(2n, 6n)), 0);
    assert.equal(cmp(rat(1n, 3n), rat(1n, 4n)), 1);
    assert.equal(cmp(rat(-1n, 2n), rat(1n, 3n)), -1);
  });

  it('converts raw on-chain integers with decimals exactly', () => {
    const sol = fromRawInt('1481481480', 9);
    assert.equal(toDecimalString(sol, 9), '1.48148148');
    const tokens = fromRawInt('29366330556388', 6);
    assert.equal(toDecimalString(tokens, 6), '29366330.556388');
    assert.equal(fromRawInt('123', null), null);
    assert.equal(fromRawInt(null, 9), null);
  });

  it('round-trips rationals through strings with zero loss', () => {
    const r = div(fromInt(1481481480), fromInt(29366330556388));
    const s = ratToString(r);
    assert.deepEqual(ratFromString(s), r);
    assert.throws(() => ratFromString('abc'), RangeError);
  });

  it('expands decimals with round-half-up', () => {
    assert.equal(toDecimalString(div(fromInt(1), fromInt(6)), 4), '0.1667');
    assert.equal(toDecimalString(div(fromInt(1), fromInt(8)), 4), '0.125');
    assert.equal(toDecimalString(fromInt(5), 2), '5');
    assert.equal(toDecimalString(rat(-1n, 200n), 4), '-0.005');
  });

  it('floors toward negative infinity', () => {
    assert.equal(floorToInt(rat(7n, 2n)), 3n);
    assert.equal(floorToInt(rat(-7n, 2n)), -4n);
  });

  it('divides by zero throws (caller must guard)', () => {
    assert.throws(() => div(fromInt(1), ZERO), RangeError);
  });
});
