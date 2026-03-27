-- ============================================
-- FIXED Migration Script for Supabase
-- Handles foreign key constraints properly
-- ============================================

-- First, let's disable foreign key checks temporarily
SET session_replication_role = replica;

-- ============================================
-- 1. APP USERS (Migrate first)
-- ============================================
-- Note: If using Supabase Auth, users should go to auth.users
-- For now, we'll insert into app_users table

-- Check if we need to create app_users or use auth.users
-- Assuming app_users table exists from schema.sql

INSERT INTO app_users (id, email, password_hash, created_at) 
SELECT id, email, password_hash, created_at 
FROM json_populate_recordset(null::app_users, '[
  -- Your app_users data will be inserted here
]')
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 2. PROFILES (Depends on app_users)
-- ============================================
INSERT INTO profiles(id, user_id, display_name, email, referral_code, created_at, updated_at)
VALUES
-- Profile data here
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 3. Other tables (in order)
-- ============================================

-- Enable foreign key checks back
SET session_replication_role = DEFAULT;
