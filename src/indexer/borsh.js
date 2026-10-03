// src/indexer/borsh.js — minimal exact Borsh reader for Pump program events.
//
// Why not @coral-xyz/anchor: the decoder must be dependency-light, version
// pinned to verified IDL layouts (see decoders/layouts.js), and must never
// silently coerce u64/i64 into JS numbers (precision loss). Every integer
// wider than 32 bits is returned as BigInt. Throws RangeError on overrun —
// callers treat that as a decode failure (failure queue), never as zeros.
//
// Layouts decoded here are verbatim from the @pump-fun/pump-sdk v2.0.0 IDL
// (pump.json / pump_amm.json), field order preserved. Verified against a real
// mainnet TradeEvent (see test/fixtures/).

export class BorshReader {
  constructor(buf) {
    this.buf = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    this.off = 0;
  }

  get remaining() {
    return this.buf.length - this.off;
  }

  _need(n, what) {
    if (this.off + n > this.buf.length) {
      throw new RangeError(
        `borsh overrun reading ${what}: need ${n} bytes at offset ${this.off}, have ${this.buf.length}`
      );
    }
  }

  u8() {
    this._need(1, 'u8');
    return this.buf.readUInt8(this.off++);
  }

  u16() {
    this._need(2, 'u16');
    const v = this.buf.readUInt16LE(this.off);
    this.off += 2;
    return v;
  }

  u32() {
    this._need(4, 'u32');
    const v = this.buf.readUInt32LE(this.off);
    this.off += 4;
    return v;
  }

  u64() {
    this._need(8, 'u64');
    const v = this.buf.readBigUInt64LE(this.off);
    this.off += 8;
    return v;
  }

  i64() {
    this._need(8, 'i64');
    const v = this.buf.readBigInt64LE(this.off);
    this.off += 8;
    return v;
  }

  i128() {
    this._need(16, 'i128');
    // Little-endian signed 128-bit via two's complement on the raw bytes.
    const lo = this.buf.readBigUInt64LE(this.off);
    const hi = this.buf.readBigUInt64LE(this.off + 8);
    this.off += 16;
    let v = (hi << 64n) | lo;
    if (hi >> 63n) v -= 1n << 128n;
    return v;
  }

  bool() {
    const v = this.u8();
    if (v !== 0 && v !== 1) throw new RangeError(`invalid bool byte: ${v}`);
    return v === 1;
  }

  pubkey() {
    this._need(32, 'pubkey');
    const v = this.buf.subarray(this.off, this.off + 32);
    this.off += 32;
    return v; // Buffer(32); callers base58-encode via web3.js PublicKey
  }

  string() {
    const len = this.u32();
    this._need(len, 'string');
    const v = this.buf.toString('utf8', this.off, this.off + len);
    this.off += len;
    return v;
  }

  /** Option<T>: 1-byte tag, then T when tag == 1. Returns null when tag == 0. */
  option(readT) {
    const tag = this.u8();
    if (tag === 0) return null;
    if (tag !== 1) throw new RangeError(`invalid option tag: ${tag}`);
    return readT(this);
  }

  /** Vec<T>: u32 length then elements. */
  vec(readT) {
    const len = this.u32();
    if (len > 1024 * 1024) throw new RangeError(`absurd vec length: ${len}`);
    const out = [];
    for (let i = 0; i < len; i++) out.push(readT(this));
    return out;
  }

  /** Read a fixed-size array of T. */
  array(n, readT) {
    const out = [];
    for (let i = 0; i < n; i++) out.push(readT(this));
    return out;
  }
}

/** Base58-encode a 32-byte pubkey Buffer without extra dependencies. */
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58Encode(buf) {
  let n = 0n;
  for (const b of buf) n = (n << 8n) | BigInt(b);
  let s = '';
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of buf) {
    if (b === 0) s = '1' + s;
    else break;
  }
  return s || '1';
}

export function pubkeyToBase58(buf) {
  if (!Buffer.isBuffer(buf) || buf.length !== 32) {
    throw new RangeError('pubkey must be a 32-byte Buffer');
  }
  return base58Encode(buf);
}
