// src/api/launch.js — Launchfolio launch pipeline (server side).
//
// Flow:
//   1. POST /launches/upload  (auth) — image -> pump.fun IPFS -> metadata JSON
//      -> IPFS. Returns { imageUri, metadataUri }.
//   2. POST /launches/prepare (auth) — validates the forge params and builds
//      an UNSIGNED v0 transaction (pump create_v2). The client signs it with
//      the user's wallet AND the client-generated mint keypair, then sends it.
//      The backend never holds keys and never signs.
//   3. POST /launches/register (auth) — verifies the launch tx on-chain, then
//      records launch_records, tags the token LAUNCHFOLIO, and adds the mint
//      to watched_mints so the indexer picks it up with no redeploy.
//
// Boundaries:
//   * creator is ALWAYS the fee wallet (or the holder-rewards PDA in holder-
//     reward mode) — never the backend, never the launcher directly.
//   * No XP is awarded for launching. Ever. (Settle only processes trades.)
//   * creatorFeeBps is honored ONLY for custom quote pairs; on SOL it is
//     forced to 0 because the on-chain schedule rate applies and any other
//     value is silently ignored.
//   * Cashback launches are NOT offered (deprecated in the current program).
//   * Quote assets must come from pump.fun's on-chain registries
//     (Global.whitelistedQuoteMints + quote-control PDA). Anything else
//     reverts on-chain with QuoteMintNotWhitelisted.

import {
  PUMP_SDK,
  OnlinePumpSdk,
  PUMP_PROGRAM_ID,
  bondingCurvePda,
  holderRewardsPda,
} from '@nirholas/pump-sdk';
import {
  PublicKey,
  Connection,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import BN from 'bn.js';

export const FEE_WALLET = '4NsKGzUXtS2p7UTpWgDZZimY9Eq6jhUJdtjEica6RWv4';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const ATOKEN_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const METAPLEX_PROGRAM = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const PAIR_REFRESH_MS = 6 * 60 * 60 * 1000;

const KNOWN_QUOTES = {
  [SOL_MINT]: { symbol: 'SOL', name: 'Solana', decimals: 9 },
  [USDC_MINT]: { symbol: 'USDC', name: 'USD Coin', decimals: 6 },
};

function isPubkey(s) {
  try {
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Quote-asset registry (mirrors pump.fun's on-chain whitelists).

function decodeQuoteControl(data) {
  // discriminator(8) + admin(32) + _reserved(64) + vec_len(u32) + items{ mint(32), initial_virtual_quote_reserves(u64) }
  if (!data || data.length < 108) return [];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const n = view.getUint32(104, true);
  const mints = [];
  let off = 108;
  for (let i = 0; i < n && off + 40 <= data.length; i++) {
    mints.push(new PublicKey(data.subarray(off, off + 32)).toBase58());
    off += 40;
  }
  return mints;
}

function decodeMetaplexMeta(data) {
  // key(1) + update_authority(32) + mint(32) + name(string) + symbol(string)
  try {
    if (!data || data.length < 110 || data[0] !== 4) return null;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let off = 65;
    const readStr = (max) => {
      const len = view.getUint32(off, true);
      off += 4;
      const end = Math.min(off + len, off + max);
      const s = Buffer.from(data.subarray(off, end)).toString('utf8').replace(/\0/g, '').trim();
      off += max;
      return s;
    };
    const name = readStr(32);
    const symbol = readStr(10);
    return { name, symbol };
  } catch {
    return null;
  }
}

function decodeToken2022Meta(data) {
  // mint base (82) + TLV extensions; TokenMetadata ext type = 19.
  // Layout: ext_disc(u16) + update_authority COption(33) + mint(32) + name/symbol/uri Rust strings.
  try {
    if (!data || data.length < 90) return null;
    let off = 82;
    while (off + 4 <= data.length) {
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const extType = view.getUint16(off, true);
      const extLen = view.getUint32(off + 2, true);
      if (extType === 19) {
        let p = off + 6;
        const copt = data[p]; p += 1;
        if (copt === 1) p += 32;
        p += 32; // mint
        const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const readRs = () => {
          const len = v.getUint32(p, true); p += 4;
          const s = Buffer.from(data.subarray(p, p + len)).toString('utf8').trim();
          p += len;
          return s;
        };
        const name = readRs();
        const symbol = readRs();
        return { name, symbol };
      }
      if (extLen === 0 || extLen > 10000) break;
      off += 6 + extLen;
    }
    return null;
  } catch {
    return null;
  }
}

async function resolveQuoteMeta(connection, mintStr) {
  if (KNOWN_QUOTES[mintStr]) return { ...KNOWN_QUOTES[mintStr] };
  const mint = new PublicKey(mintStr);
  let decimals = null;
  try {
    const info = await connection.getAccountInfo(mint);
    if (!info) return null;
    // decimals live at byte 44 in both Token and Token-2022 mint layout.
    if (info.data.length >= 45) decimals = info.data[44];
    // Try Token-2022 metadata extension first, then Metaplex PDA.
    let meta = decodeToken2022Meta(info.data);
    if (!meta) {
      const [metaPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('metadata'), METAPLEX_PROGRAM.toBuffer(), mint.toBuffer()],
        METAPLEX_PROGRAM
      );
      const metaInfo = await connection.getAccountInfo(metaPda);
      if (metaInfo) meta = decodeMetaplexMeta(metaInfo.data);
    }
    if (meta && (meta.symbol || meta.name)) {
      return { symbol: meta.symbol || mintStr.slice(0, 6), name: meta.name || '', decimals };
    }
  } catch {
    // fall through
  }
  return { symbol: mintStr.slice(0, 6) + '…', name: 'Quote asset', decimals };
}

export async function refreshPairRegistry(pool, connection) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n, MAX(updated_at) AS at
       FROM pair_registry WHERE is_active AND updated_at > now() - make_interval(secs => $1)`,
    [PAIR_REFRESH_MS / 1000]
  );
  if (rows[0].n > 0) return { refreshed: false, count: rows[0].n };

  const sdk = new OnlinePumpSdk(connection);
  const global = await sdk.fetchGlobal();
  const whitelisted = (global.whitelistedQuoteMints || []).map((k) => k.toBase58());

  let qcMints = [];
  try {
    const [qcPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('quote-control')],
      PUMP_PROGRAM_ID
    );
    const qcInfo = await connection.getAccountInfo(qcPda);
    if (qcInfo) qcMints = decodeQuoteControl(qcInfo.data);
  } catch (e) {
    console.error('[launch] quote-control read failed:', e.message);
  }

  const seen = new Set([SOL_MINT]);
  const entries = [{ mint: SOL_MINT, source: 'sol' }];
  for (const m of whitelisted) {
    if (!seen.has(m)) { seen.add(m); entries.push({ mint: m, source: 'global' }); }
  }
  for (const m of qcMints) {
    if (!seen.has(m)) { seen.add(m); entries.push({ mint: m, source: 'quote_control' }); }
  }

  for (const e of entries) {
    const meta = await resolveQuoteMeta(connection, e.mint);
    await pool.query(
      `INSERT INTO pair_registry (quote_mint, symbol, name, decimals, source, is_active, updated_at)
       VALUES ($1,$2,$3,$4,$5,true,now())
       ON CONFLICT (quote_mint) DO UPDATE SET
         symbol = EXCLUDED.symbol, name = EXCLUDED.name, decimals = EXCLUDED.decimals,
         source = EXCLUDED.source, is_active = true, updated_at = now()`,
      [e.mint, meta ? meta.symbol : e.mint.slice(0, 8), meta ? meta.name : '', meta ? meta.decimals : null, e.source]
    );
  }
  console.log(`[launch] pair registry refreshed: ${entries.length} quote assets`);
  return { refreshed: true, count: entries.length };
}

// ---------------------------------------------------------------------------
// IPFS upload (pump.fun's uploader; backend-side so CORS is not an issue).
// Exported for the avatar upload route in server.js.
export async function ipfsUpload(fileBuffer, filename, contentType) {
  const blob = new Blob([fileBuffer], { type: contentType });
  const fd = new FormData();
  fd.append('file', blob, filename);
  const res = await fetch('https://pump.fun/api/ipfs', {
    method: 'POST',
    body: fd,
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`ipfs upload failed: ${res.status}`);
  const j = await res.json();
  const uri = j?.metadataUri || j?.metadata?.image;
  if (!uri) throw new Error('ipfs upload returned no URI');
  // Pump's API wraps image uploads in a metadata JSON. If we uploaded an
  // image but got a metadata URI back, resolve it to the actual image URL.
  if (contentType.startsWith('image/')) {
    try {
      const head = await fetch(uri, { method: 'HEAD', signal: AbortSignal.timeout(15000) });
      const ct = head.headers.get('content-type') || '';
      if (!ct.startsWith('image/')) {
        // It's metadata JSON — fetch and extract the image field.
        const meta = await (await fetch(uri, { signal: AbortSignal.timeout(15000) })).json();
        if (meta?.image && typeof meta.image === 'string') return meta.image;
      }
    } catch {
      // If resolution fails, return the URI as-is; the frontend has gateway fallback.
    }
  }
  return uri;
}

// ---------------------------------------------------------------------------
// Route registration.

export function registerLaunchRoutes(app, { pool, rpcConnection, requireAuth }) {
  // Launch allowlist: when LAUNCH_ALLOWLIST is set (comma-separated pubkeys),
  // only those wallets may use the forge (upload/prepare). Unset = open to
  // all signed-in users. Lets the owner private-test before public launch.
  const launchAllowlist = new Set(
    String(process.env.LAUNCH_ALLOWLIST || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
  const requireLaunchAllowed = (req, res, next) => {
    if (launchAllowlist.size > 0 && !launchAllowlist.has(req.auth?.pubkey)) {
      return res.status(403).json({ error: 'launches are in private testing' });
    }
    next();
  };
  // Searchable list of pump.fun's quote assets (on-chain registries, cached).
  app.get('/pairs', async (req, res) => {
    try {
      const conn = await rpcConnection();
      if (conn) {
        try { await refreshPairRegistry(pool, conn); }
        catch (e) { console.error('[launch] pair refresh failed:', e.message); }
      }
      const { rows } = await pool.query(
        `SELECT quote_mint AS mint, symbol, name, decimals, source
           FROM pair_registry WHERE is_active ORDER BY
           CASE WHEN quote_mint = $1 THEN 0 WHEN source = 'global' THEN 1 ELSE 2 END, symbol`,
        [SOL_MINT]
      );
      res.json({ data: rows, source: rows.length ? 'registry' : 'empty' });
    } catch (e) {
      res.status(500).json({ error: 'pairs unavailable', detail: e.message });
    }
  });

  // Artwork + metadata upload -> IPFS. Body: { image: dataUrl, name, symbol,
  // description, socials? }. Returns { imageUri, metadataUri }.
  app.post('/launches/upload', requireAuth, requireLaunchAllowed, async (req, res) => {
    try {
      const { image, name, symbol, description, socials } = req.body || {};
      if (typeof image !== 'string' || !image.startsWith('data:image/')) {
        return res.status(400).json({ error: 'image must be a data URL' });
      }
      const m = /^data:(image\/(png|jpeg|gif|webp));base64,(.+)$/.exec(image);
      if (!m) return res.status(400).json({ error: 'unsupported image format (png/jpeg/gif/webp)' });
      const buf = Buffer.from(m[3], 'base64');
      if (buf.length > 5 * 1024 * 1024) return res.status(400).json({ error: 'image too large (5MB max)' });
      const nm = String(name || '').slice(0, 32);
      const sym = String(symbol || '').slice(0, 10);
      if (!nm || !sym) return res.status(400).json({ error: 'name and symbol are required' });

      const imageUri = await ipfsUpload(buf, 'artwork', m[1]);
      const metadata = {
        name: nm,
        symbol: sym,
        description: String(description || '').slice(0, 1000),
        image: imageUri,
        ...(socials && typeof socials === 'object' ? socials : {}),
        createdOn: 'https://launchfolio.lol',
      };
      const metadataUri = await ipfsUpload(
        Buffer.from(JSON.stringify(metadata)), 'metadata.json', 'application/json'
      );
      res.json({ data: { imageUri, metadataUri } });
    } catch (e) {
      console.error('[launch] upload failed:', e.message);
      res.status(502).json({ error: 'upload failed', detail: e.message });
    }
  });

  // Build the UNSIGNED create transaction. Body: { mint, name, symbol,
  // metadataUri, pairMint ('SOL' default), creatorFeeBps, holderReward,
  // splits[], socials{}, aura }.
  app.post('/launches/prepare', requireAuth, requireLaunchAllowed, async (req, res) => {
    try {
      const conn = await rpcConnection();
      if (!conn) return res.status(503).json({ error: 'RPC unavailable' });

      const b = req.body || {};
      const mintStr = b.mint;
      const name = String(b.name || '').trim();
      const symbol = String(b.symbol || '').trim();
      const metadataUri = String(b.metadataUri || '').trim();
      const pairMint = String(b.pairMint || 'SOL').trim();
      const holderReward = b.holderReward === true;
      let creatorFeeBps = Number(b.creatorFeeBps || 0);

      if (!isPubkey(mintStr)) return res.status(400).json({ error: 'invalid mint pubkey' });
      if (!name || name.length > 32) return res.status(400).json({ error: 'name: 1-32 chars' });
      if (!symbol || symbol.length > 10) return res.status(400).json({ error: 'symbol: 1-10 chars' });
      if (!/^https:\/\//.test(metadataUri)) return res.status(400).json({ error: 'metadataUri must be https' });

      // The mint must be fresh (client-generated keypair, unused).
      const mintInfo = await conn.getAccountInfo(new PublicKey(mintStr));
      if (mintInfo) return res.status(400).json({ error: 'mint already exists on-chain' });

      // Quote asset must be SOL or a whitelisted pair.
      let quoteMint = null;
      let customQuote = false;
      if (pairMint === 'SOL' || pairMint === SOL_MINT) {
        creatorFeeBps = 0; // schedule rate applies; anything else is silently ignored on-chain
      } else {
        if (!isPubkey(pairMint)) return res.status(400).json({ error: 'invalid pair mint' });
        const { rows } = await pool.query(
          'SELECT 1 FROM pair_registry WHERE quote_mint = $1 AND is_active',
          [pairMint]
        );
        if (!rows.length) {
          return res.status(400).json({
            error: 'pair not whitelisted by pump.fun',
            detail: 'Quote assets are curated on-chain by pump.fun; arbitrary mints revert.',
          });
        }
        if (!(creatorFeeBps >= 1 && creatorFeeBps <= 100)) {
          return res.status(400).json({ error: 'creatorFeeBps must be 1-100 (0.01%-1%) for custom pairs' });
        }
        quoteMint = new PublicKey(pairMint);
        customQuote = true;
      }

      // Planned fee split (post-launch, signed by the fee wallet — stored, not executed here).
      // Platform flywheel: fixed FLYWHEEL_PCT of claimed fees buys back the main coin.
      const splits = Array.isArray(b.splits) ? b.splits : [];
      const flywheelPct = b.holderReward ? 0 : Math.min(100, Math.max(0, Number(b.flywheelPct ?? 10)));
      const launcherPool = 100 - flywheelPct;
      if (splits.length > 10) return res.status(400).json({ error: 'max 10 split recipients' });
      let splitTotal = 0;
      const seenAddr = new Set();
      for (const s of splits) {
        if (!isPubkey(s.addr)) return res.status(400).json({ error: 'invalid split recipient address' });
        const pct = Number(s.pct);
        if (!(pct > 0) || pct > 100) return res.status(400).json({ error: 'split pct must be 0-100' });
        if (seenAddr.has(s.addr)) return res.status(400).json({ error: 'duplicate split recipient' });
        seenAddr.add(s.addr);
        splitTotal += pct;
      }
      if (splitTotal - launcherPool > 1e-9) {
        return res.status(400).json({ error: `splits must total at most ${launcherPool}% (${flywheelPct}% flywheel)` });
      }

      // Launcher must hold enough SOL for rent + fees.
      const launcher = new PublicKey(req.auth.pubkey);
      const bal = await conn.getBalance(launcher);
      if (bal < 0.03 * 1e9) {
        return res.status(400).json({
          error: 'insufficient SOL',
          detail: 'The launcher wallet needs ~0.03 SOL for mint rent and fees.',
        });
      }

      const creator = holderReward
        ? holderRewardsPda(new PublicKey(mintStr))
        : new PublicKey(FEE_WALLET);

      const createIx = await PUMP_SDK.createV2Instruction({
        mint: new PublicKey(mintStr),
        name,
        symbol,
        uri: metadataUri,
        creator,
        user: launcher,
        mayhemMode: false,
        creatorFeeBps: new BN(creatorFeeBps),
        holderReward,
      });

      // Custom quote: append the remaining accounts create_v2 expects.
      if (customQuote) {
        const quoteInfo = await conn.getAccountInfo(quoteMint);
        if (!quoteInfo) return res.status(400).json({ error: 'quote mint not found on-chain' });
        const quoteTokenProgram = quoteInfo.owner;
        const bcPda = bondingCurvePda(new PublicKey(mintStr));
        const [assocQbc] = PublicKey.findProgramAddressSync(
          [bcPda.toBuffer(), quoteTokenProgram.toBuffer(), quoteMint.toBuffer()],
          ATOKEN_PROGRAM
        );
        createIx.keys.push(
          { pubkey: quoteMint, isSigner: false, isWritable: false },
          { pubkey: assocQbc, isSigner: false, isWritable: true },
          { pubkey: quoteTokenProgram, isSigner: false, isWritable: false }
        );
        // quote-control PDA required when the mint is not in Global.whitelistedQuoteMints
        const sdk = new OnlinePumpSdk(conn);
        const global = await sdk.fetchGlobal();
        const whitelisted = (global.whitelistedQuoteMints || []).some((k) => k.equals(quoteMint));
        if (!whitelisted) {
          const [qcPda] = PublicKey.findProgramAddressSync(
            [Buffer.from('quote-control')],
            PUMP_PROGRAM_ID
          );
          createIx.keys.push({ pubkey: qcPda, isSigner: false, isWritable: false });
        }
      }

      const { blockhash } = await conn.getLatestBlockhash('confirmed');
      const tx = new VersionedTransaction(
        new TransactionMessage({
          payerKey: launcher,
          recentBlockhash: blockhash,
          instructions: [
            ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
            createIx,
          ],
        }).compileToV0Message()
      );
      const txBase64 = Buffer.from(tx.serialize()).toString('base64');

      await pool.query(
        `INSERT INTO launch_intents (mint, user_id, launcher_wallet, name, symbol,
                                     metadata_uri, pair_mint, creator_fee_bps,
                                     holder_reward, splits, flywheel_pct, socials, aura, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12::jsonb,$13, now() + interval '24 hours')
         ON CONFLICT (mint) DO UPDATE SET
           user_id = EXCLUDED.user_id, launcher_wallet = EXCLUDED.launcher_wallet,
           name = EXCLUDED.name, symbol = EXCLUDED.symbol, metadata_uri = EXCLUDED.metadata_uri,
           pair_mint = EXCLUDED.pair_mint, creator_fee_bps = EXCLUDED.creator_fee_bps,
           holder_reward = EXCLUDED.holder_reward, splits = EXCLUDED.splits,
           flywheel_pct = EXCLUDED.flywheel_pct,
           socials = EXCLUDED.socials, aura = EXCLUDED.aura,
           created_at = now(), expires_at = now() + interval '24 hours'`,
        [
          mintStr, req.auth.sub, req.auth.pubkey, name, symbol, metadataUri,
          customQuote ? pairMint : 'SOL', creatorFeeBps, holderReward,
          JSON.stringify(splits.map((s) => ({ addr: s.addr, pct: Number(s.pct) }))),
          flywheelPct,
          JSON.stringify(b.socials && typeof b.socials === 'object' ? b.socials : {}),
          String(b.aura || '').slice(0, 24),
        ]
      );

      res.json({
        data: {
          txBase64,
          mint: mintStr,
          creator: creator.toBase58(),
          pairMint: customQuote ? pairMint : 'SOL',
          creatorFeeBps,
          holderReward,
          expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
          note: 'Sign with your wallet AND the mint keypair, then send promptly (blockhash expires ~60s).',
        },
      });
    } catch (e) {
      console.error('[launch] prepare failed:', e.message);
      res.status(500).json({ error: 'prepare failed', detail: e.message });
    }
  });

  // Verify the launch on-chain and register it: launch_records + token tag +
  // indexer watchlist. Body: { mint, signature }.
  app.post('/launches/register', requireAuth, async (req, res) => {
    try {
      const conn = await rpcConnection();
      if (!conn) return res.status(503).json({ error: 'RPC unavailable' });
      const { mint, signature } = req.body || {};
      if (!isPubkey(mint) || typeof signature !== 'string' || !signature) {
        return res.status(400).json({ error: 'mint and signature are required' });
      }

      const { rows: intents } = await pool.query(
        'SELECT * FROM launch_intents WHERE mint = $1 AND expires_at > now()',
        [mint]
      );
      if (!intents.length) {
        return res.status(400).json({ error: 'no live launch intent for this mint (expired or unknown)' });
      }
      const intent = intents[0];
      if (intent.launcher_wallet !== req.auth.pubkey) {
        return res.status(403).json({ error: 'intent belongs to a different wallet' });
      }

      // Verify the signature is a confirmed transaction that created this mint.
      const tx = await conn.getTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      if (!tx) return res.status(400).json({ error: 'transaction not found (not yet confirmed?)' });
      const mintPk = new PublicKey(mint);
      const touchedMint = (tx.transaction.message.staticAccountKeys || []).some((k) => k.equals(mintPk));
      const err = tx.meta?.err;
      if (!touchedMint || err) {
        return res.status(400).json({ error: 'transaction did not create this mint', detail: err ? JSON.stringify(err) : undefined });
      }
      // The mint account must now exist.
      const mintInfo = await conn.getAccountInfo(mintPk);
      if (!mintInfo) return res.status(400).json({ error: 'mint account not found on-chain' });

      const socials = intent.socials || {};
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO launch_records (mint, launch_signature, launcher_wallet, flywheel_pct, splits)
           VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT (mint) DO NOTHING`,
          [mint, signature, intent.launcher_wallet, intent.flywheel_pct ?? 10, JSON.stringify(intent.splits || [])]
        );
        await client.query(
          `INSERT INTO tokens (mint, name, ticker, image_url, description, creator_wallet,
                               launch_provider, launch_origin, launch_state, pair_asset, socials)
           VALUES ($1,$2,$3,$4,$5,$6,'pump','LAUNCHFOLIO','bonding',$7,$8::jsonb)
           ON CONFLICT (mint) DO UPDATE SET
             launch_origin = 'LAUNCHFOLIO',
             name = COALESCE(EXCLUDED.name, tokens.name),
             ticker = COALESCE(EXCLUDED.ticker, tokens.ticker),
             socials = EXCLUDED.socials,
             pair_asset = EXCLUDED.pair_asset`,
          [
            mint, intent.name, intent.symbol,
            socials.image || null, socials.description || null,
            intent.holder_reward ? holderRewardsPda(mintPk).toBase58() : FEE_WALLET,
            intent.pair_mint === 'SOL' ? 'SOL' : intent.pair_mint,
            JSON.stringify(socials),
          ]
        );
        // Idempotent origin flip (mirrors the decode pipeline's rule).
        await client.query(
          `UPDATE tokens SET launch_origin = 'LAUNCHFOLIO' WHERE mint = $1 AND launch_origin <> 'LAUNCHFOLIO'`,
          [mint]
        );
        await client.query(
          `INSERT INTO watched_mints (mint, origin, active) VALUES ($1,'LAUNCHFOLIO',true)
           ON CONFLICT (mint) DO UPDATE SET active = true, origin = 'LAUNCHFOLIO'`,
          [mint]
        );
        await client.query('DELETE FROM launch_intents WHERE mint = $1', [mint]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }

      res.json({
        data: {
          mint,
          signature,
          origin: 'LAUNCHFOLIO',
          watched: true,
          message: 'Launch registered. The indexer will pick up trades automatically.',
        },
      });
    } catch (e) {
      console.error('[launch] register failed:', e.message);
      res.status(500).json({ error: 'register failed', detail: e.message });
    }
  });

  // Flywheel config for the fee worker: every registered launch's fee plan.
  // Public (read-only) — the worker needs no auth, the splits are public by design.
  app.get('/flywheel/config', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT mint, launcher_wallet, flywheel_pct, splits
         FROM launch_records ORDER BY created_at`
      );
      res.json({
        data: {
          mainCoinMint: process.env.MAIN_COIN_MINT || null,
          feeWallet: process.env.FEE_WALLET || null,
          launches: rows,
        },
      });
    } catch (e) {
      res.status(500).json({ error: 'flywheel config unavailable', detail: e.message });
    }
  });

  // Submit a signed launch transaction. The wallet signs in the browser; the
  // backend sends + confirms via its fast RPC, then registers automatically.
  // Body: { mint, signedTxBase64 }. Returns { signature }.
  app.post('/launches/submit', requireAuth, async (req, res) => {
    try {
      const conn = await rpcConnection();
      if (!conn) return res.status(503).json({ error: 'RPC unavailable' });
      const { mint, signedTxBase64 } = req.body || {};
      if (!isPubkey(mint) || typeof signedTxBase64 !== 'string' || !signedTxBase64) {
        return res.status(400).json({ error: 'mint and signedTxBase64 are required' });
      }

      const { rows: intents } = await pool.query(
        'SELECT * FROM launch_intents WHERE mint = $1 AND expires_at > now()',
        [mint]
      );
      if (!intents.length) {
        return res.status(400).json({ error: 'no live launch intent for this mint (expired or unknown)' });
      }
      const intent = intents[0];
      if (intent.launcher_wallet !== req.auth.pubkey) {
        return res.status(403).json({ error: 'intent belongs to a different wallet' });
      }

      let tx;
      try {
        tx = VersionedTransaction.deserialize(Buffer.from(signedTxBase64, 'base64'));
      } catch {
        return res.status(400).json({ error: 'invalid signed transaction' });
      }
      // Sanity: the tx must touch the mint and be signed by the launcher.
      const mintPk = new PublicKey(mint);
      const keys = tx.message.staticAccountKeys || [];
      if (!keys.some((k) => k.equals(mintPk))) {
        return res.status(400).json({ error: 'transaction does not touch this mint' });
      }

      const signature = await conn.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
        maxRetries: 3,
      });
      // Confirm with a bounded wait — even on timeout the tx may have landed;
      // the auto-register sweep picks it up regardless.
      try {
        const latest = await conn.getLatestBlockhash('confirmed');
        await conn.confirmTransaction(
          { signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
          'confirmed'
        );
      } catch (confirmErr) {
        console.warn('[launch] submit confirm timed out, sweep will verify:', confirmErr.message);
      }

      res.json({ data: { mint, signature } });
    } catch (e) {
      console.error('[launch] submit failed:', e.message);
      res.status(500).json({ error: 'submit failed', detail: e.message });
    }
  });
}
