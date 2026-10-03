// src/indexer/decoders/decodeLayout.js — decode a Borsh payload against a
// layout spec from layouts.js, with exact BigInt preservation.
//
// DUAL-LAYOUT RULE: several Pump events gained trailing u64 fields over time
// (e.g. TradeEvent gained holder_rewards_bps + holder_rewards = 16 bytes).
// Older events are exactly `trailingDefaultBytes` shorter; those fields decode
// as 0n (mirroring the SDK's TRADE_EVENT_LAYOUT_PADDINGS), and every decoded
// field is preserved verbatim in `raw` so the variant is auditable.
// A payload shorter by any OTHER amount is a corrupt event → throws.

import { BorshReader, pubkeyToBase58 } from '../borsh.js';

function readField(r, type) {
  if (Array.isArray(type)) {
    const [kind, arg] = type;
    if (kind === 'vec') {
      const [structKind, fields] = arg;
      if (structKind !== 'struct') throw new Error(`unsupported vec element: ${structKind}`);
      return r.vec((rr) => readStruct(rr, fields));
    }
    throw new Error(`unsupported compound type: ${kind}`);
  }
  switch (type) {
    case 'u8': return r.u8();
    case 'u16': return r.u16();
    case 'u32': return r.u32();
    case 'u64': return r.u64();
    case 'i64': return r.i64();
    case 'i128': return r.i128();
    case 'bool': return r.bool();
    case 'pubkey': return pubkeyToBase58(r.pubkey());
    case 'string': return r.string();
    default: throw new Error(`unsupported field type: ${type}`);
  }
}

function readStruct(r, fields) {
  const out = {};
  for (const [name, type] of fields) out[name] = readField(r, type);
  return out;
}

/**
 * @param {Buffer} payload - Borsh bytes AFTER the 8-byte discriminator.
 * @param {Array} layout - [[name, type], ...] from layouts.js.
 * @param {number} trailingDefaultBytes - 0 or 16; older shorter payloads get
 *        zero-filled trailing fields (exactly this many bytes' worth).
 * @returns decoded fields object (BigInts preserved).
 */
export function decodeLayout(payload, layout, trailingDefaultBytes = 0) {
  // How many trailing u64/i64 fields fit the padding budget, from the end.
  const padFields = [];
  if (trailingDefaultBytes > 0) {
    let bytes = 0;
    for (let i = layout.length - 1; i >= 0 && bytes < trailingDefaultBytes; i--) {
      const [, type] = layout[i];
      if (type !== 'u64' && type !== 'i64') break;
      padFields.unshift(layout[i]);
      bytes += 8;
    }
    if (bytes !== trailingDefaultBytes) {
      throw new Error(`layout padding mismatch: cannot pad ${trailingDefaultBytes} bytes`);
    }
  }
  const mainFields = layout.slice(0, layout.length - padFields.length);

  let padded = false;
  let buf = payload;
  if (trailingDefaultBytes > 0 && payload.length > 0) {
    // Determine expected full length by decoding main fields first on a probe.
    const probe = new BorshReader(payload);
    readStruct(probe, mainFields);
    const mainLen = probe.off;
    const fullLen = mainLen + padFields.length * 8;
    if (payload.length === fullLen - trailingDefaultBytes) {
      buf = Buffer.concat([payload, Buffer.alloc(trailingDefaultBytes)]);
      padded = true;
    } else if (payload.length !== fullLen) {
      throw new RangeError(
        `event payload length ${payload.length} matches neither current (${fullLen}) nor legacy (${fullLen - trailingDefaultBytes}) layout`
      );
    }
  }

  const r = new BorshReader(buf);
  const out = readStruct(r, layout);
  out.__padded_legacy_layout = padded;
  if (r.remaining !== 0) {
    throw new RangeError(`event payload has ${r.remaining} trailing bytes after decode`);
  }
  return out;
}

/** JSON-safe copy of decoded fields (BigInt → decimal string). */
export function fieldsToJson(fields) {
  return JSON.parse(
    JSON.stringify(fields, (_, v) => (typeof v === 'bigint' ? v.toString() : v))
  );
}
