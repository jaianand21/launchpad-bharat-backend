-- launchpad_bharat_fix.sql
-- Run this in the Supabase SQL Editor

-- ── 1. ADD MISSING COLUMNS (SAFE & NON-DESTRUCTIVE) ────────────────────────
-- This ensures the DB matches the code expectations.
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_picture text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS business_stage text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS business_type text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS goal text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_mobile_verified boolean DEFAULT false;

-- Rename 'mobile' to 'mobile_number' and 'joined_at' to 'created_at' if they exist.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='mobile') THEN
        ALTER TABLE users RENAME COLUMN mobile TO mobile_number;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='joined_at') THEN
        ALTER TABLE users RENAME COLUMN joined_at TO created_at;
    END IF;
END $$;

-- ── 2. SYNCING THE BLUEPRINTS TABLE ────────────────────────────────────────
-- This ensures all metadata from the AI generation is saved correctly.
ALTER TABLE blueprints_generated ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE blueprints_generated ADD COLUMN IF NOT EXISTS skills text;
ALTER TABLE blueprints_generated ADD COLUMN IF NOT EXISTS niches text;
ALTER TABLE blueprints_generated ADD COLUMN IF NOT EXISTS budget text;
ALTER TABLE blueprints_generated ADD COLUMN IF NOT EXISTS user_id int8;
ALTER TABLE blueprints_generated ADD COLUMN IF NOT EXISTS timestamp timestamptz DEFAULT now();
ALTER TABLE blueprints_generated ADD COLUMN IF NOT EXISTS time_stamp timestamptz DEFAULT now();

-- ── 3. RE-SEQUENCING USER IDs (CLEAN START) ────────────────────────────────
-- This part makes the IDs 1, 2, 3... in order of when they joined.
-- NOTE: If you have blueprints already generated, this will keep them linked
-- as long as we use this specific transaction block.
BEGIN;
  -- Backup users with their new intended order
  CREATE TEMP TABLE users_temp AS SELECT * FROM users ORDER BY created_at ASC;
  
  -- Clear existing users (this resets the ID counter)
  -- If this fails because of "foreign key constraints", it means you have
  -- important blueprints linked to these users.
  TRUNCATE users RESTART IDENTITY CASCADE;
  
  -- Re-insert users
  INSERT INTO users (
    name, email, mobile_number, created_at, 
    profile_picture, auth_provider, business_stage, business_type, goal, 
    last_login, updated_at, password_hash, google_id, is_mobile_verified
  ) 
  SELECT 
    name, email, mobile_number, created_at, 
    profile_picture, auth_provider, business_stage, business_type, goal, 
    last_login, updated_at, password_hash, google_id, is_mobile_verified 
  FROM users_temp;
COMMIT;
