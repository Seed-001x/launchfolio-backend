-- 011_flywheel_pct.sql — persist the platform flywheel cut per launch.
--
-- The flywheel is a fixed % of claimed creator fees that buys back the main
-- coin. Stored on the intent (forge session) and copied to launch_records on
-- register, so the fee worker can read each launch's plan.

ALTER TABLE launch_intents
  ADD COLUMN IF NOT EXISTS flywheel_pct INTEGER NOT NULL DEFAULT 10;

ALTER TABLE launch_records
  ADD COLUMN IF NOT EXISTS flywheel_pct INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS splits JSONB NOT NULL DEFAULT '[]'::jsonb;
