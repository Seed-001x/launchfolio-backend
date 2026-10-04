-- 005_watched_mints_and_crank_purge.sql
--
-- 1) watched_mints: the indexer's watchlist lives in the DB now, not only in
--    the WATCHLIST_MINTS env var. The indexer unions DB rows (active=true)
--    with the env var and hot-reloads, so a launch through the pad starts
--    being indexed without a redeploy or env-var edit.
-- 2) Purge CRANK (mint DroqcqiWsD1DvTw1r4WmCpxb2Frwz2kqQYF1gPsgaaX6): it belongs
--    to the Crankpad project, not Launchfolio. Deleting the tokens row
--    cascades to trades, transfers, positions, cards, fee_events and
--    binder_snapshots via ON DELETE CASCADE.

CREATE TABLE IF NOT EXISTS watched_mints (
  mint       TEXT PRIMARY KEY,
  origin     TEXT NOT NULL DEFAULT 'LAUNCHFOLIO'
               CHECK (origin IN ('LAUNCHFOLIO', 'EXTERNAL_PUMP')),
  added_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  active     BOOLEAN NOT NULL DEFAULT true
);
CREATE INDEX IF NOT EXISTS idx_watched_mints_active ON watched_mints(active);

-- CRANK purge
DELETE FROM launch_records
 WHERE mint = 'DroqcqiWsD1DvTw1r4WmCpxb2Frwz2kqQYF1gPsgaaX6';
DELETE FROM tokens
 WHERE mint = 'DroqcqiWsD1DvTw1r4WmCpxb2Frwz2kqQYF1gPsgaaX6';
UPDATE xp_events
   SET token_mint = NULL
 WHERE token_mint = 'DroqcqiWsD1DvTw1r4WmCpxb2Frwz2kqQYF1gPsgaaX6';
DELETE FROM indexer_checkpoints
 WHERE job_name = 'watch:DroqcqiWsD1DvTw1r4WmCpxb2Frwz2kqQYF1gPsgaaX6';
