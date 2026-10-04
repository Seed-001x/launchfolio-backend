-- 004_profile_avatar.sql — profile fields: avatar URL on users.
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
