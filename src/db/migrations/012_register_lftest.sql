-- 012_register_lftest.sql — register the LFTEST test coin.
--
-- Launched 2026-10-04 ~16:52 EDT (mint AkREdmsePKDvB6SSitJhQSjYSa3CZ21YFcvwB2qSKUSM).
-- The launch transaction succeeded on-chain but the browser's confirmation
-- timed out, so POST /launches/register never ran. This inserts the same rows
-- the register endpoint would have created. Idempotent — safe to re-apply.
--
-- (The auto-register sweep added in this release handles this automatically
-- going forward; this migration covers the coin that launched before it.)

INSERT INTO launch_records (mint, launch_signature, launcher_wallet, flywheel_pct, splits)
VALUES ('AkREdmsePKDvB6SSitJhQSjYSa3CZ21YFcvwB2qSKUSM',
        '2g1885JvxoQk6ttw5jPS3XPLmftY6ZvwT47p6KDW7pHtwQ7My429M8Ywv5EUMxgLu2ZsgAMgYsEd7Qm6FdrPAxq5',
        '4NsKGzUXtS2p7UTpWgDZZimY9Eq6jhUJdtjEica6RWv4',
        10, '[]'::jsonb)
ON CONFLICT (mint) DO NOTHING;

INSERT INTO tokens (mint, name, ticker, creator_wallet,
                    launch_provider, launch_origin, launch_state, pair_asset)
VALUES ('AkREdmsePKDvB6SSitJhQSjYSa3CZ21YFcvwB2qSKUSM',
        'Launchfolio Test', 'LFTEST',
        '4NsKGzUXtS2p7UTpWgDZZimY9Eq6jhUJdtjEica6RWv4',
        'pump', 'LAUNCHFOLIO', 'bonding', 'SOL')
ON CONFLICT (mint) DO UPDATE SET
  launch_origin = 'LAUNCHFOLIO',
  name = COALESCE(EXCLUDED.name, tokens.name),
  ticker = COALESCE(EXCLUDED.ticker, tokens.ticker);

INSERT INTO watched_mints (mint, origin, active)
VALUES ('AkREdmsePKDvB6SSitJhQSjYSa3CZ21YFcvwB2qSKUSM', 'LAUNCHFOLIO', true)
ON CONFLICT (mint) DO UPDATE SET active = true, origin = 'LAUNCHFOLIO';
