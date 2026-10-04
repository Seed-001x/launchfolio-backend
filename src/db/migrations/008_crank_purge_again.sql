-- 008_crank_purge_again.sql
--
-- The 005 purge ran, but the indexer re-indexed CRANK from the stale
-- WATCHLIST_MINTS env var before the DB-only watchlist (watch.js) took
-- effect. Purge it again. With the env var now ignored, it stays gone.

DELETE FROM launch_records
 WHERE mint = 'DroqcqiWsD1DvTw1r4WmCpxb2Frwz2kqQYF1gPsgaaX6';
DELETE FROM tokens
 WHERE mint = 'DroqcqiWsD1DvTw1r4WmCpxb2Frwz2kqQYF1gPsgaaX6';
UPDATE xp_events
   SET token_mint = NULL
 WHERE token_mint = 'DroqcqiWsD1DvTw1r4WmCpxb2Frwz2kqQYF1gPsgaaX6';
DELETE FROM indexer_checkpoints
 WHERE job_name = 'watch:DroqcqiWsD1DvTw1r4WmCpxb2Frwz2kqQYF1gPsgaaX6';
