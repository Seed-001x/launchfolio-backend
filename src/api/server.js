#!/usr/bin/env node
// src/api/server.js — Launchfolio backend REST API.
//
// Powers the production frontend with VERIFIED indexed data. Rules:
//
//   * Every number comes from the database (indexed on-chain activity).
//     Empty table -> empty array / null. NEVER mock data, NEVER fabricated
//     metrics, UNKNOWN is null not 0.
//   * The client is never trusted for wallet ownership, PnL, XP, cards,
//     leaderboard scores, fee accounting, or binder qualification. All
//     derived values are computed server-side by the engines in src/engines/.
//   * Demo and verified boards are never mixed. This API serves verified
//     data only; the Demo Mode prototype keeps its own mock leaderboard.
//
// Run: npm run api   (or: node src/api/server.js)
// Env: DATABASE_URL (required), JWT_SECRET, PORT, RPC_URL (for live
//      holder/portfolio reads; those endpoints 503 gracefully without it).

import express from 'express';
import { pool } from '../db/pool.js';
import { issueNonce, verifySignature, requireAuth } from '../auth/wallet.js';
import { registerLaunchRoutes, ipfsUpload } from './launch.js';
import { trendingScore, TRENDING_WEIGHTS } from '../engines/trending.js';

const PORT = Number(process.env.PORT || 3000);
const STALE_AFTER_MS = 5 * 60 * 1000; // market data older than this is flagged stale

const app = express();
app.use(express.json({ limit: '256kb' }));

// Express 4 does not catch errors thrown in async route handlers — without
// this, one failed DB query would crash the whole API. Wrap every route so
// async failures become 500s, never process crashes.
for (const m of ['get', 'post', 'patch', 'put', 'delete']) {
  const orig = app[m].bind(app);
  app[m] = (path, ...handlers) =>
    orig(
      path,
      ...handlers.map((h) => (req, res, next) =>
        Promise.resolve(h(req, res, next)).catch(next)
      )
    );
}

// (Error-handling middleware is registered at the bottom, after all routes.)

// ---------------------------------------------------------------- helpers
const isStale = (lastUpdatedAt) =>
  !lastUpdatedAt || Date.now() - new Date(lastUpdatedAt).getTime() > STALE_AFTER_MS;

async function rpcConnection() {
  if (!process.env.RPC_URL) return null;
  const { Connection } = await import('@solana/web3.js');
  return new Connection(process.env.RPC_URL, 'confirmed');
}

// ---------------------------------------------------------------- auth
app.post('/auth/nonce', issueNonce);
app.post('/auth/verify', verifySignature);

// Example user-scoped write, protected: set your own handle.
app.patch('/users/:id/handle', requireAuth, async (req, res) => {
  if (req.auth.sub !== req.params.id) {
    return res.status(403).json({ error: 'you can only edit your own profile' });
  }
  const { handle } = req.body ?? {};
  if (typeof handle !== 'string' || handle.length > 32) {
    return res.status(400).json({ error: 'invalid handle' });
  }
  const { rows } = await pool.query(
    'UPDATE users SET handle = $1 WHERE id = $2 RETURNING id, handle',
    [handle, req.params.id]
  );
  res.json(rows[0]);
});

// Full profile edit: display name + avatar URL. Self-only, authenticated.
app.patch('/users/:id/profile', requireAuth, async (req, res) => {
  if (req.auth.sub !== req.params.id) {
    return res.status(403).json({ error: 'you can only edit your own profile' });
  }
  const { handle, avatar_url } = req.body ?? {};
  if (handle !== undefined && handle !== null && (typeof handle !== 'string' || handle.length > 32)) {
    return res.status(400).json({ error: 'invalid handle' });
  }
  if (
    avatar_url !== undefined && avatar_url !== null && avatar_url !== '' &&
    (typeof avatar_url !== 'string' || avatar_url.length > 500 || !/^https?:\/\/.+/i.test(avatar_url))
  ) {
    return res.status(400).json({ error: 'avatar must be an http(s) URL' });
  }
  const { rows } = await pool.query(
    `UPDATE users SET
       handle = COALESCE($1, handle),
       avatar_url = NULLIF($2, '')
     WHERE id = $3 RETURNING id, handle, avatar_url`,
    [handle ?? null, avatar_url ?? null, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'user not found' });
  res.json(rows[0]);
});

// Avatar upload: image -> IPFS, URL saved to the user's profile.
// Self-only, authenticated. Body: { image: dataUrl }. Returns { avatar_url }.
app.post('/users/:id/avatar', requireAuth, async (req, res) => {
  if (req.auth.sub !== req.params.id) {
    return res.status(403).json({ error: 'you can only edit your own profile' });
  }
  try {
    const { image } = req.body ?? {};
    if (typeof image !== 'string' || !image.startsWith('data:image/')) {
      return res.status(400).json({ error: 'image must be a data URL' });
    }
    const m = /^data:(image\/(png|jpeg|gif|webp));base64,(.+)$/.exec(image);
    if (!m) return res.status(400).json({ error: 'unsupported image format (png/jpeg/gif/webp)' });
    const buf = Buffer.from(m[3], 'base64');
    if (buf.length > 5 * 1024 * 1024) return res.status(400).json({ error: 'image too large (5MB max)' });
    const avatarUrl = await ipfsUpload(buf, 'avatar', m[1]);
    const { rows } = await pool.query(
      'UPDATE users SET avatar_url = $1 WHERE id = $2 RETURNING id, handle, avatar_url',
      [avatarUrl, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'user not found' });
    res.json({ avatar_url: rows[0].avatar_url });
  } catch (e) {
    res.status(500).json({ error: e.message || 'avatar upload failed' });
  }
});

// ---------------------------------------------------------------- tokens
const SORTS = {
  newest: 't.created_at DESC NULLS LAST',
  mcap: 't.mcap DESC NULLS LAST',
  volume: 't.volume_24h DESC NULLS LAST',
  holders: 't.holder_count DESC NULLS LAST',
};

app.get('/tokens', async (req, res) => {
  const { origin, state, sort = 'newest', q } = req.query;
  const where = [];
  const params = [];

  if (origin === 'LAUNCHFOLIO' || origin === 'EXTERNAL_PUMP') {
    params.push(origin);
    where.push(`t.launch_origin = $${params.length}`);
  }
  if (state === 'bonding' || state === 'graduated') {
    params.push(state);
    where.push(`t.launch_state = $${params.length}`);
  }
  if (typeof q === 'string' && q.trim()) {
    params.push(`%${q.trim()}%`);
    const p = params.length;
    where.push(
      `(t.name ILIKE $${p} OR t.ticker ILIKE $${p} OR t.mint = $${p} OR t.creator_wallet = $${p})`
    );
  }

  let orderBy = SORTS[sort] || SORTS.newest;
  let rows;
  if (sort === 'trending') {
    rows = (await pool.query(
      `SELECT t.* FROM tokens t ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`,
      params
    )).rows;
    rows = await sortByTrending(rows);
  } else {
    rows = (
      await pool.query(
        `SELECT t.* FROM tokens t ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${orderBy} LIMIT 100`,
        params
      )
    ).rows;
  }

  res.json({
    data: rows.map(withStaleness),
    source: 'verified', // indexed on-chain data; empty array when nothing indexed
  });
});

/** Rank tokens by the TrendingEngine over the trailing 24h of indexed trades. */
async function sortByTrending(tokens) {
  if (!tokens.length) return tokens;
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { rows } = await pool.query(
    `SELECT mint,
            COUNT(*)::int AS trades,
            COUNT(DISTINCT wallet)::int AS unique_traders,
            COALESCE(SUM(pair_amount), 0) AS volume_sol
     FROM trades WHERE block_time >= $1 GROUP BY mint`,
    [since]
  );
  const byMint = new Map(rows.map((r) => [r.mint, r]));
  const maxima = {
    uniqueTraders: Math.max(1, ...rows.map((r) => r.unique_traders)),
    volumeSol: Math.max(1e-9, ...rows.map((r) => Number(r.volume_sol))),
    tradesPerHour: Math.max(1e-9, ...rows.map((r) => r.trades / 24)),
  };
  const scored = tokens.map((t) => {
    const m = byMint.get(t.mint);
    const ageHours = t.created_at
      ? (Date.now() - new Date(t.created_at).getTime()) / 3600000
      : 720;
    return {
      t,
      score: m
        ? trendingScore(
            {
              uniqueTraders: m.unique_traders,
              volumeSol: Number(m.volume_sol),
              tradesPerHour: m.trades / 24,
              holderGrowthPct: 0, // TODO: track holder snapshots for growth
              priceMovePct: 0, // TODO: derive from candle buckets
              ageHours,
            },
            maxima,
            TRENDING_WEIGHTS
          )
        : 0,
    };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.t);
}

function withStaleness(t) {
  return { ...t, stale: isStale(t.last_updated_at) };
}

app.get('/tokens/:mint', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM tokens WHERE mint = $1', [
    req.params.mint,
  ]);
  if (!rows.length) return res.status(404).json({ error: 'token not indexed' });
  res.json({ data: withStaleness(rows[0]), source: 'verified' });
});

app.get('/tokens/:mint/trades', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const { rows } = await pool.query(
    `SELECT signature, event_index, wallet, side, token_amount, pair_amount,
            usd_estimate, execution_price, mcap_at_execution, slot, block_time, confirmation
     FROM trades WHERE mint = $1 ORDER BY block_time DESC NULLS LAST, id DESC LIMIT $2`,
    [req.params.mint, limit]
  );
  res.json({ data: rows, source: 'verified' });
});

app.get('/tokens/:mint/holders', async (req, res) => {
  const conn = await rpcConnection();
  if (!conn) {
    return res.status(503).json({
      error: 'holder data delayed',
      detail: 'RPC_URL is not configured; holder reads are unavailable, not zero.',
    });
  }
  try {
    const { PublicKey } = await import('@solana/web3.js');
    const mint = new PublicKey(req.params.mint);
    const [largest, supply] = await Promise.all([
      conn.getTokenLargestAccounts(mint),
      conn.getTokenSupply(mint),
    ]);
    const total = Number(supply.value.amount);
    const holders = largest.value.map((h) => ({
      address: h.address.toBase58(),
      amount: h.amount,
      pct: total > 0 ? (Number(h.amount) / total) * 100 : null,
    }));
    res.json({ data: { holders, total_supply: supply.value.amount }, source: 'rpc-live' });
  } catch (err) {
    res.status(503).json({ error: 'holder data delayed', detail: err.message });
  }
});

const CANDLE_INTERVALS = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '4h': 14400,
  '1d': 86400,
};

// Candles are bucketed from VERIFIED trades only. Buckets with no trades
// are omitted — we never invent candles for missing periods.
app.get('/tokens/:mint/candles', async (req, res) => {
  const seconds = CANDLE_INTERVALS[req.query.interval];
  if (!seconds) {
    return res.status(400).json({ error: 'interval must be one of 1m|5m|15m|1h|4h|1d' });
  }
  const { rows } = await pool.query(
    `SELECT block_time, execution_price, token_amount
     FROM trades
     WHERE mint = $1 AND execution_price IS NOT NULL AND block_time IS NOT NULL
     ORDER BY block_time ASC`,
    [req.params.mint]
  );
  const buckets = new Map();
  for (const t of rows) {
    const ts = Math.floor(new Date(t.block_time).getTime() / 1000);
    const open = Math.floor(ts / seconds) * seconds;
    let b = buckets.get(open);
    if (!b) {
      b = { time: open, open: t.execution_price, high: t.execution_price, low: t.execution_price, close: t.execution_price, volume: 0 };
      buckets.set(open, b);
    }
    b.high = Math.max(b.high, t.execution_price);
    b.low = Math.min(b.low, t.execution_price);
    b.close = t.execution_price;
    b.volume += Number(t.token_amount);
  }
  res.json({ data: [...buckets.values()], source: 'verified', note: 'buckets with no trades are omitted' });
});

// ---------------------------------------------------------------- wallets
app.get('/wallets/:pubkey/portfolio', async (req, res) => {
  const conn = await rpcConnection();
  if (!conn) {
    return res.status(503).json({
      error: 'portfolio unavailable',
      detail: 'RPC_URL is not configured.',
    });
  }
  try {
    const { PublicKey } = await import('@solana/web3.js');
    const owner = new PublicKey(req.params.pubkey);
    const [sol, tokenAccounts] = await Promise.all([
      conn.getBalance(owner),
      conn.getParsedTokenAccountsByOwner(owner, { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') }),
    ]);
    const holdings = tokenAccounts.value
      .map((a) => {
        const info = a.account.data.parsed.info;
        const amt = Number(info.tokenAmount.uiAmountString);
        return amt > 0
          ? { mint: info.mint, balance: amt, decimals: info.tokenAmount.decimals }
          : null;
      })
      .filter(Boolean);
    // Enrich with indexed token metadata where available.
    const mints = holdings.map((h) => h.mint);
    let meta = new Map();
    if (mints.length) {
      const { rows } = await pool.query(
        'SELECT mint, name, ticker, image_url, price, mcap, launch_origin FROM tokens WHERE mint = ANY($1)',
        [mints]
      );
      meta = new Map(rows.map((r) => [r.mint, r]));
    }
    res.json({
      data: {
        sol_balance: sol / 1e9,
        holdings: holdings.map((h) => ({ ...h, token: meta.get(h.mint) ?? null })),
      },
      source: 'rpc-live',
      note: 'balances are live; token transfers are never treated as purchases',
    });
  } catch (err) {
    res.status(503).json({ error: 'portfolio unavailable', detail: err.message });
  }
});

app.get('/wallets/:pubkey/positions', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM positions WHERE wallet = $1 ORDER BY updated_at DESC',
    [req.params.pubkey]
  );
  res.json({ data: rows, source: 'verified' });
});

// ---------------------------------------------------------------- users / cards / leaderboard
app.get('/users/:id/cards', async (req, res) => {
  const { rows: wallets } = await pool.query(
    'SELECT pubkey FROM wallets WHERE user_id = $1',
    [req.params.id]
  );
  if (!wallets.length) return res.json({ data: [], source: 'verified' });
  const pubkeys = wallets.map((w) => w.pubkey);
  const { rows } = await pool.query(
    'SELECT * FROM cards WHERE wallet = ANY($1) ORDER BY created_at DESC',
    [pubkeys]
  );
  res.json({ data: rows, source: 'verified' });
});

app.get('/leaderboard', async (req, res) => {
  const board = req.query.board || 'verified';
  if (board === 'demo') {
    // The demo/mock leaderboard lives in the Demo Mode prototype. This API
    // never mixes fake users with real ones.
    return res.status(400).json({
      error: 'demo board not served here',
      detail:
        'The demo leaderboard is served by the Demo Mode prototype. Verified and demo boards are never mixed.',
    });
  }
  if (board !== 'verified') {
    return res.status(400).json({ error: 'board must be verified' });
  }
  const { rows } = await pool.query(
    `SELECT u.id AS user_id, u.handle, COALESCE(SUM(e.amount), 0)::int AS xp,
            COUNT(e.event_id)::int AS xp_events
     FROM users u
     LEFT JOIN xp_events e ON e.user_id = u.id
     GROUP BY u.id, u.handle
     ORDER BY xp DESC
     LIMIT 100`
  );
  res.json({ data: rows, board: 'verified', source: 'verified' });
});

// ---------------------------------------------------------------- creators
app.get('/creators/:wallet', async (req, res) => {
  const wallet = req.params.wallet;
  const { rows: tokens } = await pool.query(
    'SELECT * FROM tokens WHERE creator_wallet = $1 ORDER BY created_at DESC NULLS LAST',
    [wallet]
  );
  const { rows: launches } = await pool.query(
    'SELECT mint, launch_signature FROM launch_records WHERE launcher_wallet = $1',
    [wallet]
  );
  const launchfolioMints = new Set(launches.map((l) => l.mint));
  res.json({
    data: {
      wallet,
      launches: tokens.map((t) => ({
        ...withStaleness(t),
        is_launchfolio_origin: launchfolioMints.has(t.mint),
      })),
    },
    source: 'verified',
    note: 'Launchfolio-origin status requires a verified launch record; it is never inferred from Pump presence.',
  });
});

// ---------------------------------------------------------------- economy
app.get('/economy/fees', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT fee_type,
            COUNT(*)::int AS events,
            COALESCE(SUM(amount), 0) AS total_amount,
            COALESCE(SUM(launchfolio_allocation), 0) AS total_launchfolio_allocation
     FROM fee_events GROUP BY fee_type`
  );
  res.json({
    verified: rows,
    simulated: null, // simulated economy lives in the Demo Mode prototype; never combined
    note: 'verified and simulated values are never combined into one number. No payouts or buybacks are executed.',
    source: 'verified',
  });
});

// ---------------------------------------------------------------- health

// Launch pipeline: pairs registry, IPFS upload, unsigned-tx prepare, on-chain register.
registerLaunchRoutes(app, { pool, rpcConnection, requireAuth });

app.get('/health', async (req, res) => {  const { rows: checkpoints } = await pool.query('SELECT * FROM indexer_checkpoints');
  const counts = {};
  for (const t of ['tokens', 'trades', 'positions', 'cards', 'xp_events', 'fee_events']) {
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM ${t}`);
    counts[t] = rows[0].n;
  }
  // Indexer decode observability (decode upgrade): per-job stats, unresolved
  // decode failures, and trades still missing resolved decimals.
  let indexerStats = [];
  let unresolvedFailures = null;
  let unresolvedDecimals = null;
  try {
    ({ rows: indexerStats } = await pool.query('SELECT * FROM indexer_stats'));
    const { rows: f } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM decode_failures WHERE resolved = FALSE'
    );
    unresolvedFailures = f[0].n;
    const { rows: d } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM trades WHERE token_decimals IS NULL'
    );
    unresolvedDecimals = d[0].n;
  } catch {
    // Pre-migration databases lack the new tables; health must not 500.
  }
  res.json({
    ok: true,
    indexer_checkpoints: checkpoints,
    row_counts: counts,
    rpc_configured: Boolean(process.env.RPC_URL),
    indexer_stats: indexerStats,
    decode_failures_unresolved: unresolvedFailures,
    trades_missing_decimals: unresolvedDecimals,
    decoder_versions: {
      pump_bonding: 'pump-bonding-v1',
      pump_swap: 'pumpswap-v1',
      positions: 'positions/v2',
      cards: 'cards/v2',
      xp: 'xp/v2',
    },
  });
});

// Global error handler: async route failures become JSON 500s, never crashes.
app.use((err, _req, res, _next) => {
  console.error('[api] request failed:', err.message);
  res.status(500).json({ error: 'internal error' });
});

// ---------------------------------------------------------------- boot
app.listen(PORT, () => {
  console.log(`[api] listening on :${PORT}`);
  if (!process.env.DATABASE_URL) console.warn('[api] DATABASE_URL is not set — requests will fail');
  if (!process.env.JWT_SECRET) console.warn('[api] JWT_SECRET is not set — auth will fail');
  if (!process.env.RPC_URL) console.warn('[api] RPC_URL is not set — holder/portfolio endpoints will 503');
});
