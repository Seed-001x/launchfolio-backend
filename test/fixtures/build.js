// test/fixtures/build.js — builds deterministic test fixtures.
//
// Run: node test/fixtures/build.js
//
// Two kinds of fixtures:
//   1. REAL: test/fixtures/tx_buy_real.json — an actual mainnet Pump buy
//      transaction (signature documented in FIXTURES.md), fetched via RPC.
//      Expected decoded values are asserted in test/borsh.test.js.
//   2. SYNTHETIC: minimal getTransaction-shaped JSON whose `Program data:`
//      payloads are encoded with the REAL IDL discriminators + Borsh field
//      order from src/indexer/decoders/layouts.js (the TradeEvent layout was
//      verified byte-for-byte against the real tx above). These exercise
//      sells, creates, graduations, AMM events, multi-event txs, inner
//      instructions, failed txs, legacy layouts, and v0 messages — shapes
//      that are expensive to hunt on mainnet but structurally identical.
//
// Nothing here touches the network except copying the already-fetched real tx.

import { writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PublicKey } from '@solana/web3.js';
import {
  PUMP_EVENT_DISCRIMINATORS,
  PUMP_AMM_EVENT_DISCRIMINATORS,
  PROGRAM_IDS,
} from '../../src/indexer/decoders/layouts.js';

const dir = dirname(fileURLToPath(import.meta.url));
mkdirSync(dir, { recursive: true });

// ------------------------------------------------------------------ helpers
// Deterministic fake pubkeys: 32 bytes filled with the seed byte.
function pk(seed) {
  return new PublicKey(Buffer.alloc(32, seed)).toBase58();
}
const PUMP = PROGRAM_IDS.PUMP;
const AMM = PROGRAM_IDS.PUMP_AMM;
const WSOL = 'So11111111111111111111111111111111111111112';

const MINT = pk(11);
const USER = pk(21);
const CREATOR = pk(22);
const BONDING_CURVE = pk(23);
const POOL = pk(24);
const FEE_RECIPIENT = pk(25);
const ROUTER = pk(26); // fake aggregator program (outer instruction)

class Enc {
  constructor() {
    this.parts = [];
  }
  u8(v) { const b = Buffer.alloc(1); b.writeUInt8(v); this.parts.push(b); return this; }
  u16(v) { const b = Buffer.alloc(2); b.writeUInt16LE(v); this.parts.push(b); return this; }
  u64(v) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); this.parts.push(b); return this; }
  i64(v) { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); this.parts.push(b); return this; }
  i128(v) {
    let x = BigInt(v);
    if (x < 0) x += 1n << 128n;
    const b = Buffer.alloc(16);
    b.writeBigUInt64LE(x & 0xffffffffffffffffn, 0);
    b.writeBigUInt64LE((x >> 64n) & 0xffffffffffffffffn, 8);
    this.parts.push(b); return this;
  }
  bool(v) { return this.u8(v ? 1 : 0); }
  pubkey(s) { this.parts.push(Buffer.from(new PublicKey(s).toBytes())); return this; }
  string(s) {
    const b = Buffer.from(s, 'utf8');
    const l = Buffer.alloc(4); l.writeUInt32LE(b.length);
    this.parts.push(l, b); return this;
  }
  buf() { return Buffer.concat(this.parts); }
}

function eventData(discriminator, enc) {
  return Buffer.concat([Buffer.from(discriminator), enc.buf()]).toString('base64');
}

// Minimal getTransaction-shaped JSON (compiled message form).
//
// STEP 12: fixtures carry economically CONSISTENT balance data so the
// balance reconciler (src/indexer/reconcileTrade.js) can be exercised:
// preBalances/postBalances per account index plus pre/postTokenBalances.
// tokenBalances entries: { accountIndex, mint, owner, amount, decimals }.
// Balances default to a uniform 1B lamports / no token accounts; pass
// `balances: { pre: {idx: lamports}, post: {idx: lamports} }` and
// `tokenBalances: { pre: [...], post: [...] }` to override.
function tb(accountIndex, mint, owner, amount, decimals = 6) {
  return {
    accountIndex, mint, owner,
    uiTokenAmount: { amount: String(amount), decimals, uiAmount: null, uiAmountString: String(amount) },
  };
}

function makeTx({ signature, slot = 300000001, blockTime = 1759147200, err = null,
  version = 'legacy', accountKeys, instructions, logs, balances = null, tokenBalances = null }) {
  const message = version === 'legacy'
    ? { accountKeys, instructions }
    : { accountKeys, instructions, version: 0 };
  const n = accountKeys.length;
  const preB = Array(n).fill(1000000000);
  const postB = Array(n).fill(1000000000);
  if (balances) {
    for (const [i, v] of Object.entries(balances.pre ?? {})) preB[Number(i)] = v;
    for (const [i, v] of Object.entries(balances.post ?? {})) postB[Number(i)] = v;
  }
  const tx = {
    slot,
    blockTime,
    transaction: { signatures: [signature], message },
    meta: {
      err,
      fee: 5000,
      logMessages: logs,
      preBalances: preB,
      postBalances: postB,
      preTokenBalances: tokenBalances?.pre ?? [],
      postTokenBalances: tokenBalances?.post ?? [],
      loadedAddresses: version === 'legacy' ? undefined : { writable: [], readonly: [] },
    },
  };
  if (version === 'legacy') delete tx.meta.loadedAddresses;
  return tx;
}

function sig(seed) {
  return new PublicKey(Buffer.alloc(32, seed)).toBase58(); // any base58 string works
}

function invokeLogs(programId, depth, dataB64s) {
  const lines = [`Program ${programId} invoke [${depth}]`];
  for (const d of dataB64s) lines.push(`Program data: ${d}`);
  lines.push(`Program ${programId} success`);
  return lines;
}

// ------------------------------------------------------------------ events
function tradeEvent({ isBuy, solAmount, tokenAmount, ixName = 'buy', legacy = false,
  mint = MINT, user = USER, fee = 14074075n, creatorFee = 4444445n }) {
  const e = new Enc()
    .pubkey(mint)
    .u64(solAmount).u64(tokenAmount).bool(isBuy).pubkey(user).i64(1759147200n)
    .u64(100000000000n).u64(800000000000000n).u64(5000000000n).u64(400000000000000n)
    .pubkey(FEE_RECIPIENT).u64(95n).u64(fee)
    .pubkey(CREATOR).u64(30n).u64(creatorFee)
    .bool(true)
    .u64(0n).u64(0n).u64(0n).i64(1759147200n)
    .string(ixName).bool(false)
    .u64(0n).u64(0n).u64(0n).u64(0n);
  // shareholders vec (empty)
  const vl = Buffer.alloc(4); vl.writeUInt32LE(0); e.parts.push(vl);
  e.pubkey(WSOL).u64(solAmount).u64(100000000000n).u64(5000000000n);
  if (!legacy) e.u64(0n).u64(0n); // holder_rewards_bps + holder_rewards
  return eventData(PUMP_EVENT_DISCRIMINATORS.TradeEvent, e);
}

function createEvent({ mint = MINT, creator = CREATOR } = {}) {
  const e = new Enc()
    .string('Test Token').string('TEST').string('https://example.com/meta.json')
    .pubkey(mint).pubkey(BONDING_CURVE).pubkey(USER).pubkey(creator).i64(1759147200n)
    .u64(1073000000000000n).u64(30000000000n).u64(1073000000000000n).u64(1000000000000000n)
    .pubkey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
    .bool(false).bool(false)
    .pubkey(WSOL).u64(30000000000n).u64(30n).bool(false);
  return eventData(PUMP_EVENT_DISCRIMINATORS.CreateEvent, e);
}

function migrationEvent({ mint = MINT, pool = POOL } = {}) {
  const e = new Enc()
    .pubkey(USER).pubkey(mint).u64(100000000000000n).u64(8500000000n).u64(6000000n)
    .pubkey(BONDING_CURVE).i64(1759147200n).pubkey(pool).pubkey(WSOL);
  return eventData(PUMP_EVENT_DISCRIMINATORS.CompletePumpAmmMigrationEvent, e);
}

function ammBuyEvent({ pool = POOL, baseOut = 1000000000n, quoteIn = 2000000n, legacy = false }) {
  const e = new Enc()
    .i64(1759147300n)
    .u64(baseOut).u64(quoteIn + 10000n)
    .u64(5000000000n).u64(9000000000n)
    .u64(8000000000000n).u64(16000000000n)
    .u64(quoteIn).u64(25n).u64(50000n).u64(5n).u64(10000n)
    .u64(quoteIn + 50000n).u64(quoteIn)
    .pubkey(pool).pubkey(USER).pubkey(pk(31)).pubkey(pk(32))
    .pubkey(FEE_RECIPIENT).pubkey(pk(33))
    .pubkey(CREATOR).u64(25n).u64(50000n)
    .bool(true).u64(0n).u64(0n).u64(0n).i64(1759147300n)
    .u64(baseOut - 1000n).string('buy')
    .u64(0n).u64(0n).u64(0n).u64(0n)
    .i128(16000000000n).bool(false).u64(1000000000000000n);
  if (!legacy) e.u64(0n).u64(0n);
  return eventData(PUMP_AMM_EVENT_DISCRIMINATORS.BuyEvent, e);
}

function ammSellEvent({ pool = POOL, baseIn = 1000000000n, quoteOut = 1900000n, legacy = false }) {
  const e = new Enc()
    .i64(1759147400n)
    .u64(baseIn).u64(quoteOut - 10000n)
    .u64(4000000000n).u64(9000000000n)
    .u64(8000000000000n).u64(16000000000n)
    .u64(quoteOut).u64(25n).u64(47500n).u64(5n).u64(9500n)
    .u64(quoteOut + 47500n).u64(quoteOut)
    .pubkey(pool).pubkey(USER).pubkey(pk(31)).pubkey(pk(32))
    .pubkey(FEE_RECIPIENT).pubkey(pk(33))
    .pubkey(CREATOR).u64(25n).u64(47500n)
    .u64(0n).u64(0n).u64(0n).u64(0n)
    .i128(16000000000n).bool(false).u64(1000000000000000n);
  if (!legacy) e.u64(0n).u64(0n);
  return eventData(PUMP_AMM_EVENT_DISCRIMINATORS.SellEvent, e);
}

function ammCreatePoolEvent({ pool = POOL, baseMint = MINT } = {}) {
  const e = new Enc()
    .i64(1759147250n).u16(0)
    .pubkey(USER).pubkey(baseMint).pubkey(WSOL)
    .u8(6).u8(9)
    .u64(100000000000000n).u64(8500000000n)
    .u64(100000000000000n).u64(8500000000n)
    .u64(1000n).u64(100000000000000n).u64(100000000000000n)
    .u8(255).pubkey(pool).pubkey(pk(34)).pubkey(pk(35)).pubkey(pk(36))
    .pubkey(CREATOR).bool(false).u64(25n).bool(true).bool(false);
  return eventData(PUMP_AMM_EVENT_DISCRIMINATORS.CreatePoolEvent, e);
}

// ------------------------------------------------------------------ fixtures
const fixtures = {};

// Balance economics per fixture (USER=idx 0, fee payer; FEE=5000; ATA rent=2039280).
const U0 = 5000000000;
const RENT = 2039280;

// 1. Synthetic bonding buy (top-level instruction)
//    SOL out: 1,481,481,480 (gross) + 5,000 (fee) + 2,039,280 (new ATA)
fixtures['bonding-buy'] = makeTx({
  signature: sig(101),
  accountKeys: [USER, MINT, PUMP],
  instructions: [{ programIdIndex: 2, accounts: [0, 1], data: 'abc' }],
  logs: invokeLogs(PUMP, 1, [tradeEvent({ isBuy: true, solAmount: 1481481480n, tokenAmount: 29366330556388n })]),
  balances: { pre: { 0: U0 }, post: { 0: U0 - 1481481480 - 5000 - RENT } },
  tokenBalances: { pre: [], post: [tb(3, MINT, USER, 29366330556388n)] },
});

// 2. Synthetic bonding sell (token account stays open, post balance 0)
fixtures['bonding-sell'] = makeTx({
  signature: sig(102),
  accountKeys: [USER, MINT, PUMP],
  instructions: [{ programIdIndex: 2, accounts: [0, 1], data: 'abc' }],
  logs: invokeLogs(PUMP, 1, [tradeEvent({ isBuy: false, solAmount: 900000000n, tokenAmount: 15000000000000n, ixName: 'sell' })]),
  balances: { pre: { 0: U0 }, post: { 0: U0 + 900000000 - 5000 } },
  tokenBalances: { pre: [tb(3, MINT, USER, 15000000000000n)], post: [tb(3, MINT, USER, 0n)] },
});

// 3. Create
fixtures['bonding-create'] = makeTx({
  signature: sig(103),
  accountKeys: [USER, MINT, PUMP],
  instructions: [{ programIdIndex: 2, accounts: [0, 1], data: 'abc' }],
  logs: invokeLogs(PUMP, 1, [createEvent()]),
});

// 4. Graduation (migration)
fixtures['bonding-graduation'] = makeTx({
  signature: sig(104),
  accountKeys: [USER, MINT, PUMP, AMM],
  instructions: [
    { programIdIndex: 2, accounts: [0, 1], data: 'abc' },
    { programIdIndex: 3, accounts: [0, 1], data: 'def' },
  ],
  logs: [
    ...invokeLogs(PUMP, 1, [migrationEvent()]),
    ...invokeLogs(AMM, 1, [ammCreatePoolEvent()]),
  ],
});

// 5. Multi-event: create + buy in one tx
//    SOL out: 1,000,000,000 (gross) + 5,000 (fee) + 2,039,280 (new ATA)
fixtures['bonding-multi'] = makeTx({
  signature: sig(105),
  accountKeys: [USER, MINT, PUMP],
  instructions: [
    { programIdIndex: 2, accounts: [0, 1], data: 'create' },
    { programIdIndex: 2, accounts: [0, 1], data: 'buy' },
  ],
  logs: [
    ...invokeLogs(PUMP, 1, [createEvent()]),
    ...invokeLogs(PUMP, 1, [tradeEvent({ isBuy: true, solAmount: 1000000000n, tokenAmount: 20000000000000n })]),
  ],
  balances: { pre: { 0: U0 }, post: { 0: U0 - 1000000000 - 5000 - RENT } },
  tokenBalances: { pre: [], post: [tb(3, MINT, USER, 20000000000000n)] },
});

// 6. Inner instruction: router (outer) -> pump buy (inner invoke [2]).
//    Aggregator-routed: SOL-side reconciliation is SKIPPED for this trade
//    (router economics invisible); the token side must still match exactly.
fixtures['bonding-inner'] = makeTx({
  signature: sig(106),
  accountKeys: [USER, MINT, ROUTER, PUMP],
  instructions: [{ programIdIndex: 2, accounts: [0, 1], data: 'route' }],
  logs: [
    `Program ${ROUTER} invoke [1]`,
    `Program ${PUMP} invoke [2]`,
    `Program data: ${tradeEvent({ isBuy: true, solAmount: 500000000n, tokenAmount: 9000000000000n })}`,
    `Program ${PUMP} success`,
    `Program ${ROUTER} success`,
  ],
  balances: { pre: { 0: U0 }, post: { 0: 4400000000 } }, // router took its cut; skipped anyway
  tokenBalances: { pre: [], post: [tb(4, MINT, USER, 9000000000000n)] },
});

// 7. Failed tx: meta.err set, logs contain a trade event → must be excluded
fixtures['bonding-failed'] = makeTx({
  signature: sig(107),
  err: { InstructionError: [0, 'Custom'] },
  accountKeys: [USER, MINT, PUMP],
  instructions: [{ programIdIndex: 2, accounts: [0, 1], data: 'abc' }],
  logs: [
    ...invokeLogs(PUMP, 1, [tradeEvent({ isBuy: true, solAmount: 999999999n, tokenAmount: 99999999999999n })]),
    `Program ${PUMP} failed: custom program error: 0x1`,
  ],
});

// 8. Legacy (short) TradeEvent — 16 bytes shorter, padded with zeros
fixtures['bonding-legacy-trade'] = makeTx({
  signature: sig(108),
  accountKeys: [USER, MINT, PUMP],
  instructions: [{ programIdIndex: 2, accounts: [0, 1], data: 'abc' }],
  logs: invokeLogs(PUMP, 1, [tradeEvent({ isBuy: true, solAmount: 777000000n, tokenAmount: 11111111111111n, legacy: true })]),
  balances: { pre: { 0: U0 }, post: { 0: U0 - 777000000 - 5000 - RENT } },
  tokenBalances: { pre: [], post: [tb(3, MINT, USER, 11111111111111n)] },
});

// 9. AMM buy + sell (pool known via the graduation fixture's pool).
//    amm-buy: trader wraps 2M lamports -> WSOL (net WSOL delta 0: wrap in,
//    spend out), pays 2M WSOL for 1B base; new base ATA costs rent.
//    SOL out: 2,000,000 (wrap) + 5,000 (fee) + 2,039,280 (new base ATA).
fixtures['amm-buy'] = makeTx({
  signature: sig(109),
  accountKeys: [USER, POOL, AMM],
  instructions: [{ programIdIndex: 2, accounts: [0, 1], data: 'abc' }],
  logs: invokeLogs(AMM, 1, [ammBuyEvent({})]),
  balances: { pre: { 0: U0 }, post: { 0: U0 - 2000000 - 5000 - RENT } },
  tokenBalances: {
    pre: [tb(3, WSOL, USER, 10000000n, 9)],
    post: [tb(3, WSOL, USER, 10000000n, 9), tb(4, MINT, USER, 1000000000n)],
  },
});
//    amm-sell: trader sells 1B base for 1.9M WSOL, unwraps everything and
//    closes the WSOL account (rent returned).
//    SOL in: 11,900,000 (unwrap) - 5,000 (fee) + 2,039,280 (rent return).
fixtures['amm-sell'] = makeTx({
  signature: sig(110),
  accountKeys: [USER, POOL, AMM],
  instructions: [{ programIdIndex: 2, accounts: [0, 1], data: 'abc' }],
  logs: invokeLogs(AMM, 1, [ammSellEvent({})]),
  balances: { pre: { 0: U0 }, post: { 0: U0 + 11900000 - 5000 + RENT } },
  tokenBalances: {
    pre: [tb(3, WSOL, USER, 10000000n, 9), tb(4, MINT, USER, 5000000000n)],
    post: [tb(4, MINT, USER, 4000000000n)],
  },
});

// 10. AMM trade with UNKNOWN pool → decode failure (never guessed)
fixtures['amm-unknown-pool'] = makeTx({
  signature: sig(111),
  accountKeys: [USER, pk(99), AMM],
  instructions: [{ programIdIndex: 2, accounts: [0, 1], data: 'abc' }],
  logs: invokeLogs(AMM, 1, [ammBuyEvent({ pool: pk(99) })]),
});

// 11. v0 versioned transaction (address lookup tables shape)
//    Sell: 2,222,222,222,222 tokens -> 123,456,789 lamports net; token account
//    stays open (pre 3T -> post 777,777,777,778).
fixtures['v0-tx'] = makeTx({
  signature: sig(112),
  version: 'v0',
  accountKeys: [USER, MINT, PUMP],
  instructions: [{ programIdIndex: 2, accounts: [0, 1], data: 'abc' }],
  logs: invokeLogs(PUMP, 1, [tradeEvent({ isBuy: false, solAmount: 123456789n, tokenAmount: 2222222222222n, ixName: 'sell_v2' })]),
  balances: { pre: { 0: U0 }, post: { 0: U0 + 123456789 - 5000 } },
  tokenBalances: {
    pre: [tb(3, MINT, USER, 3000000000000n)],
    post: [tb(3, MINT, USER, 777777777778n)],
  },
});

// 12. Unknown Program data (not a pump event) → skipped, not a failure
fixtures['unknown-data'] = makeTx({
  signature: sig(113),
  accountKeys: [USER, MINT, PUMP],
  instructions: [{ programIdIndex: 2, accounts: [0, 1], data: 'abc' }],
  logs: [
    `Program ${PUMP} invoke [1]`,
    `Program log: Instruction: Buy`,
    `Program data: ${Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]).toString('base64')}`,
    `Program ${PUMP} success`,
  ],
});

// 13. Tiny amounts: 7,000 lamports for 1,000 raw token units (0.001 tokens).
//     Exercises dust-scale values and exact normalized decimals.
fixtures['bonding-tiny'] = makeTx({
  signature: sig(114),
  accountKeys: [USER, MINT, PUMP],
  instructions: [{ programIdIndex: 2, accounts: [0, 1], data: 'abc' }],
  logs: invokeLogs(PUMP, 1, [tradeEvent({ isBuy: true, solAmount: 7000n, tokenAmount: 1000n })]),
  balances: { pre: { 0: U0 }, post: { 0: U0 - 7000 - 5000 - RENT } },
  tokenBalances: { pre: [], post: [tb(3, MINT, USER, 1000n)] },
});

// 14. Unrelated instructions in the same tx: a System transfer between two
//     OTHER accounts must not confuse the decoder or the reconciler (the
//     trader's own flows are unaffected).
const OTHER1 = pk(41);
const OTHER2 = pk(42);
fixtures['bonding-unrelated'] = makeTx({
  signature: sig(115),
  accountKeys: [USER, MINT, PUMP, OTHER1, OTHER2],
  instructions: [
    { programIdIndex: 2, accounts: [0, 1], data: 'abc' },
    { programIdIndex: 4, accounts: [3, 4], data: 'transfer' },
  ],
  logs: [
    ...invokeLogs(PUMP, 1, [tradeEvent({ isBuy: true, solAmount: 250000000n, tokenAmount: 4000000000000n })]),
    'Program 11111111111111111111111111111111 invoke [1]',
    'Program log: Instruction: Transfer',
    'Program 11111111111111111111111111111111 success',
  ],
  balances: {
    pre: { 0: U0, 3: 1000000000, 4: 1000000000 },
    post: { 0: U0 - 250000000 - 5000 - RENT, 3: 999000000, 4: 1001000000 },
  },
  tokenBalances: { pre: [], post: [tb(5, MINT, USER, 4000000000000n)] },
});

// ------------------------------------------------------------------ write
for (const [name, tx] of Object.entries(fixtures)) {
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(tx));
  console.log(`[fixtures] wrote ${name}.json`);
}

// Copy the real mainnet buy tx.
try {
  copyFileSync('/tmp/pump-research/tx1.json', join(dir, 'tx_buy_real.json'));
  console.log('[fixtures] copied tx_buy_real.json (real mainnet buy)');
} catch (err) {
  console.warn('[fixtures] WARNING: real tx not available:', err.message);
}

writeFileSync(
  join(dir, 'FIXTURES.md'),
  `# Test fixtures\n\n` +
    `## Real mainnet fixture\n\n` +
    `- \`tx_buy_real.json\`: real Pump bonding-curve BUY fetched from mainnet via\n` +
    `  public RPC on 2026-09-29. Routed through an aggregator (inner instruction).\n` +
    `  Verified decode: sol_amount=1481481480 lamports (1.48148148 SOL),\n` +
    `  token_amount=29366330556388, is_buy=true, ix_name="buy", fee=14074075\n` +
    `  (95 bps), creator_fee=4444445 (30 bps). The user's wallet balance delta\n` +
    `  (1,517,105,000 lamports) exceeds sol_amount+fees because of aggregator\n` +
    `  fees/ATA rent — which is exactly why event amounts (not balance deltas)\n` +
    `  are authoritative.\n\n` +
    `## Synthetic fixtures\n\n` +
    `Built by \`build.js\` with the REAL Anchor discriminators and Borsh field\n` +
    `order from \`src/indexer/decoders/layouts.js\` (the TradeEvent layout was\n` +
    `verified byte-for-byte against the real tx above). They are structurally\n` +
    `identical to mainnet transactions for the paths they exercise.\n\n` +
    `| file | exercises |\n` +
    `|---|---|\n` +
    `| bonding-buy.json | top-level buy decode, exact amounts |\n` +
    `| bonding-sell.json | sell decode (net proceeds semantics) |\n` +
    `| bonding-tiny.json | dust-scale amounts (7,000 lamports / 1,000 raw units) |\n` +
    `| bonding-unrelated.json | unrelated System transfer in the same tx |\n` +
    `| bonding-create.json | launch detection |\n` +
    `| bonding-graduation.json | migration event + AMM pool creation |\n` +
    `| bonding-multi.json | two events in one tx (create+buy), per-event index |\n` +
    `| bonding-inner.json | inner-instruction (CPI) attribution via router |\n` +
    `| bonding-failed.json | failed tx exclusion (meta.err) |\n` +
    `| bonding-legacy-trade.json | 16-byte-shorter legacy TradeEvent (zero-pad path) |\n` +
    `| amm-buy.json / amm-sell.json | PumpSwap trade decode with pool attribution |\n` +
    `| amm-unknown-pool.json | unknown pool → decode failure, mint never guessed |\n` +
    `| v0-tx.json | versioned (v0) transaction message shape |\n` +
    `| unknown-data.json | unrecognized Program data → skipped, not a failure |\n\n` +
    `## Balance modeling (STEP 12)\n\n` +
    `Trade fixtures carry economically CONSISTENT balance data\n` +
    `(\`preBalances\`/\`postBalances\` per account index plus\`pre/postTokenBalances\`)\n` +
    `so the balance reconciler (\`src/indexer/reconcileTrade.js\`) can be\n` +
    `exercised end-to-end. Conventions: the trader (account 0, fee payer)\n` +
    `starts at 5,000,000,000 lamports, \`meta.fee\` = 5,000, and each token\n` +
    `account created in-tx costs 2,039,280 lamports of ATA rent. Aggregator-\n` +
    `routed fixtures (e.g. \`bonding-inner\`) intentionally model only the\n` +
    `token side exactly — the SOL side is skipped by design.\n`
);
console.log('[fixtures] wrote FIXTURES.md');
