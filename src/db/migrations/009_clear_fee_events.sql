-- 009_clear_fee_events.sql
--
-- fee_events still holds 7 orphan network_fee rows (mint NULL) left over
-- from indexing CRANK's transactions. Launchfolio has no launches, so this
-- table should start empty. Future rows come only from real launches.
-- (network_fee events are written with mint=NULL by decode.js, which is why
-- the token purge's cascade did not remove them.)

DELETE FROM fee_events;
