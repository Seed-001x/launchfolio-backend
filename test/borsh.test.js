// test/borsh.test.js — Borsh reader + TradeEvent layout verification.
//
// The centerpiece: test/fixtures/tx_buy_real.json is a REAL mainnet Pump buy.
// Its `Program data:` TradeEvent must decode to the exact verified values:
//   sol_amount=1481481480 (1.48148148 SOL), token_amount=29366330556388,
//   is_buy=true, ix_name="buy", fee=14074075 (95 bps), creator_fee=4444445 (30 bps).
// The Borsh reader must consume EXACTLY the payload (0 bytes remaining).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BorshReader, pubkeyToBase58, base58Encode } from '../src/indexer/borsh.js';
import { decodeLayout } from '../src/indexer/decoders/decodeLayout.js';
import {
  TRADE_EVENT_LAYOUT,
  TRADE_EVENT_TRAILING_DEFAULT_BYTES,
  PUMP_EVENT_DISCRIMINATORS,
} from '../src/indexer/decoders/layouts.js';
import { PublicKey } from '@solana/web3.js';

const dir = dirname(fileURLToPath(import.meta.url));
const load = (name) => JSON.parse(readFileSync(join(dir, 'fixtures', name), 'utf8'));

function programDataLine(tx) {
  const line = tx.meta.logMessages.find((l) => l.startsWith('Program data:'));
  return Buffer.from(line.slice('Program data: '.length), 'base64');
}

describe('borsh reader primitives', () => {
  it('reads integers as BigInt with exact values', () => {
    const buf = Buffer.alloc(24);
    buf.writeUInt8(0xff, 0);
    buf.writeUInt16LE(0xffff, 1);
    buf.writeUInt32LE(0xffffffff, 3);
    buf.writeBigUInt64LE(18446744073709551615n, 7);
    buf.writeBigInt64LE(-9223372036854775808n, 15);
    buf.writeUInt8(1, 23);
    const l = Buffer.alloc(4); l.writeUInt32LE(3, 0);
    const r = new BorshReader(Buffer.concat([buf, l, Buffer.from('abc'), Buffer.from([0])]));
    assert.equal(r.u8(), 255);
    assert.equal(r.u16(), 65535);
    assert.equal(r.u32(), 4294967295);
    assert.equal(r.u64(), 18446744073709551615n);
    assert.equal(r.i64(), -9223372036854775808n);
    assert.equal(r.bool(), true);
    assert.equal(r.string(), 'abc');
    assert.equal(r.option((rr) => rr.u8()), null);
    assert.equal(r.remaining, 0);
  });

  it('throws on overrun instead of returning garbage', () => {
    const r = new BorshReader(Buffer.alloc(3));
    assert.throws(() => r.u64(), RangeError);
    assert.throws(() => r.string(), RangeError);
  });

  it('rejects invalid bool/option tags', () => {
    assert.throws(() => new BorshReader(Buffer.from([7])).bool(), RangeError);
    assert.throws(() => new BorshReader(Buffer.from([9])).option((r) => r.u8()), RangeError);
  });

  it('base58-encodes pubkeys identically to web3.js', () => {
    const bytes = Buffer.alloc(32);
    for (let i = 0; i < 32; i++) bytes[i] = (i * 37 + 11) & 0xff;
    assert.equal(pubkeyToBase58(bytes), new PublicKey(bytes).toBase58());
    assert.equal(base58Encode(Buffer.alloc(32, 0)), '11111111111111111111111111111111');
  });
});

describe('real mainnet TradeEvent decode', () => {
  const tx = load('tx_buy_real.json');
  const raw = programDataLine(tx);
  const disc = [...raw.subarray(0, 8)];

  it('has the documented TradeEvent discriminator', () => {
    assert.deepEqual(disc, PUMP_EVENT_DISCRIMINATORS.TradeEvent);
  });

  it('decodes every field with exact amounts and zero trailing bytes', () => {
    const e = decodeLayout(raw.subarray(8), TRADE_EVENT_LAYOUT, TRADE_EVENT_TRAILING_DEFAULT_BYTES);
    assert.equal(e.sol_amount, 1481481480n);
    assert.equal(e.token_amount, 29366330556388n);
    assert.equal(e.is_buy, true);
    assert.equal(e.ix_name, 'buy');
    assert.equal(e.fee_basis_points, 95n);
    assert.equal(e.fee, 14074075n);
    assert.equal(e.creator_fee_basis_points, 30n);
    assert.equal(e.creator_fee, 4444445n);
    assert.equal(e.__padded_legacy_layout, false);
    // Pubkeys decode to valid base58.
    assert.doesNotThrow(() => new PublicKey(e.mint));
    assert.doesNotThrow(() => new PublicKey(e.user));
    assert.equal(e.quote_amount, 1481481480n);
  });

  it('rejects a payload with an unexpected length (not silent zeros)', () => {
    const short = raw.subarray(8, raw.length - 7); // corrupt: 7 bytes missing
    assert.throws(() => decodeLayout(short, TRADE_EVENT_LAYOUT, TRADE_EVENT_TRAILING_DEFAULT_BYTES), RangeError);
  });

  it('zero-pads the legacy 16-byte-shorter layout', () => {
    const legacyTx = load('bonding-legacy-trade.json');
    const legacyRaw = programDataLine(legacyTx);
    assert.equal(legacyRaw.length, raw.length - 16);
    const e = decodeLayout(legacyRaw.subarray(8), TRADE_EVENT_LAYOUT, TRADE_EVENT_TRAILING_DEFAULT_BYTES);
    assert.equal(e.__padded_legacy_layout, true);
    assert.equal(e.holder_rewards_bps, 0n);
    assert.equal(e.holder_rewards, 0n);
    assert.equal(e.sol_amount, 777000000n);
    assert.equal(e.token_amount, 11111111111111n);
  });
});
