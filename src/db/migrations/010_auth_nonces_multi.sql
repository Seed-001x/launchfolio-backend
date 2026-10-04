-- 010_auth_nonces_multi.sql
--
-- Allow multiple outstanding nonces per pubkey (multi-tab / multi-device
-- sign-in). Previously pubkey was the PRIMARY KEY and issueNonce overwrote
-- the row on every call, so two tabs signing in at once invalidated each
-- other's nonces: every verify came back 401 and sign-in could never
-- complete. Nonces stay single-use via the `used` flag; verify now looks up
-- the exact (pubkey, nonce) pair.

ALTER TABLE auth_nonces DROP CONSTRAINT IF EXISTS auth_nonces_pkey;
ALTER TABLE auth_nonces ADD COLUMN id BIGSERIAL PRIMARY KEY;
CREATE INDEX IF NOT EXISTS idx_auth_nonces_lookup ON auth_nonces (pubkey, nonce);
-- Prune long-expired nonces so the table stays small.
DELETE FROM auth_nonces WHERE expires_at < now() - interval '1 hour';
