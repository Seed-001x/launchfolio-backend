// src/api/autoRegister.js — automatic launch registration sweep.
//
// The manual POST /launches/register step is fragile: if the user's browser
// loses track of the transaction (e.g. confirmation timeout), the coin is
// live on-chain but the backend never learns about it. This sweep closes that
// gap: every minute it checks live launch_intents, and any mint that now
// exists on-chain is registered automatically (launch_records + token tag +
// indexer watchlist), using the intent's metadata. The intent is then deleted.
//
// Security: intents are created by authenticated, allowlisted wallets with a
// client-generated random mint. Only the launcher knows the mint address
// before it exists, so mint existence is sufficient proof of launch.

import { PublicKey } from '@solana/web3.js';
import { holderRewardsPda } from '@nirholas/pump-sdk';

const FEE_WALLET = '4NsKGzUXtS2p7UTpWgDZZimY9Eq6jhUJdtjEica6RWv4';

export async function autoRegisterSweep({ pool, rpcConnection }) {
  let intents;
  try {
    ({ rows: intents } = await pool.query(
      'SELECT * FROM launch_intents WHERE expires_at > now() ORDER BY created_at'
    ));
  } catch (e) {
    console.error('[auto-register] intent read failed:', e.message);
    return;
  }
  if (!intents.length) return;

  const conn = await rpcConnection();
  if (!conn) return;

  for (const intent of intents) {
    const mint = intent.mint;
    try {
      const mintPk = new PublicKey(mint);
      const acct = await conn.getAccountInfo(mintPk, 'confirmed');
      if (!acct) continue; // not launched yet — keep the intent for next sweep

      // Grab a signature that touched the mint for the launch record.
      let launchSig = null;
      try {
        const sigs = await conn.getSignaturesForAddress(mintPk, { limit: 1 }, 'confirmed');
        if (sigs.length) launchSig = sigs[0].signature;
      } catch { /* non-fatal */ }
      if (!launchSig) continue;

      const socials = intent.socials || {};
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO launch_records (mint, launch_signature, launcher_wallet, flywheel_pct, splits)
           VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT (mint) DO NOTHING`,
          [mint, launchSig, intent.launcher_wallet, intent.flywheel_pct ?? 10, JSON.stringify(intent.splits || [])]
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
        console.log(`[auto-register] ${intent.symbol || mint} (${mint}) registered automatically`);
      } catch (e) {
        await client.query('ROLLBACK');
        console.error(`[auto-register] ${mint} failed:`, e.message);
      } finally {
        client.release();
      }
    } catch (e) {
      console.error(`[auto-register] ${mint} check failed:`, e.message);
    }
  }
}

export function startAutoRegister({ pool, rpcConnection, intervalMs = 60000 }) {
  // Run once at boot (after a short delay), then on the interval.
  const run = () => autoRegisterSweep({ pool, rpcConnection }).catch((e) =>
    console.error('[auto-register] sweep crashed:', e.message)
  );
  setTimeout(run, 15000);
  setInterval(run, intervalMs);
  console.log('[auto-register] sweep scheduled every', intervalMs, 'ms');
}
