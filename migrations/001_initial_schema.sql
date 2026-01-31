-- Bo Multi-Tenant PostgreSQL Schema Migration
-- Migration: 001_initial_schema
-- Description: Create multi-tenant tables with family isolation

-- ============================================================================
-- FAMILIES & MEMBERSHIPS
-- ============================================================================

CREATE TABLE IF NOT EXISTS families (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_families_created_at ON families(created_at);

-- ============================================================================
-- USERS
-- ============================================================================

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  phone_number TEXT NOT NULL UNIQUE,
  telegram_id TEXT UNIQUE,
  can_trigger_agent BOOLEAN NOT NULL DEFAULT true,
  timezone_iana TEXT NOT NULL DEFAULT 'America/New_York',
  last_active_family_id INTEGER REFERENCES families(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_telegram_id ON users(telegram_id) WHERE telegram_id IS NOT NULL;
CREATE INDEX idx_users_phone_number ON users(phone_number);
CREATE INDEX idx_users_last_active_family ON users(last_active_family_id);

-- ============================================================================
-- FAMILY MEMBERSHIPS (many-to-many with roles)
-- ============================================================================

CREATE TYPE family_role AS ENUM ('owner', 'manager', 'member');

CREATE TABLE IF NOT EXISTS family_memberships (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  role family_role NOT NULL DEFAULT 'member',
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, family_id)
);

CREATE INDEX idx_family_memberships_user ON family_memberships(user_id);
CREATE INDEX idx_family_memberships_family ON family_memberships(family_id);
CREATE INDEX idx_family_memberships_role ON family_memberships(family_id, role);

-- Trigger: Ensure at least one owner per family
CREATE OR REPLACE FUNCTION ensure_family_has_owner() RETURNS TRIGGER AS $$
BEGIN
  IF (NEW.role != 'owner' AND OLD.role = 'owner') OR (TG_OP = 'DELETE' AND OLD.role = 'owner') THEN
    IF NOT EXISTS (
      SELECT 1 FROM family_memberships 
      WHERE family_id = COALESCE(NEW.family_id, OLD.family_id) 
        AND role = 'owner' 
        AND id != COALESCE(NEW.id, OLD.id)
    ) THEN
      RAISE EXCEPTION 'Cannot remove last owner from family';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER check_family_owner_before_update
  BEFORE UPDATE ON family_memberships
  FOR EACH ROW
  EXECUTE FUNCTION ensure_family_has_owner();

CREATE TRIGGER check_family_owner_before_delete
  BEFORE DELETE ON family_memberships
  FOR EACH ROW
  EXECUTE FUNCTION ensure_family_has_owner();

-- ============================================================================
-- USER PERSONALITIES (per-family)
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_personalities (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  instructions JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, family_id)
);

CREATE INDEX idx_user_personalities_user_family ON user_personalities(user_id, family_id);

-- ============================================================================
-- FACTS (with family isolation)
-- ============================================================================

CREATE TABLE IF NOT EXISTS facts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'user' CHECK (scope IN ('user', 'family', 'global')),
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, family_id, key, scope)
);

CREATE INDEX idx_facts_user_family ON facts(user_id, family_id);
CREATE INDEX idx_facts_family ON facts(family_id);
CREATE INDEX idx_facts_scope ON facts(scope);
CREATE INDEX idx_facts_key ON facts(key);

-- ============================================================================
-- CONVERSATION (with family isolation)
-- ============================================================================

CREATE TABLE IF NOT EXISTS conversation (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, family_id, seq)
);

CREATE INDEX idx_conversation_user_family_seq ON conversation(user_id, family_id, seq);
CREATE INDEX idx_conversation_family ON conversation(family_id);

-- ============================================================================
-- SUMMARY (with family isolation)
-- ============================================================================

CREATE TABLE IF NOT EXISTS summary (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  sentences JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, family_id)
);

CREATE INDEX idx_summary_user_family ON summary(user_id, family_id);

-- ============================================================================
-- TODOS (with family isolation)
-- ============================================================================

CREATE TABLE IF NOT EXISTS todos (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  creator_user_id INTEGER REFERENCES users(id),
  text TEXT NOT NULL,
  done BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_todos_user_family ON todos(user_id, family_id);
CREATE INDEX idx_todos_family ON todos(family_id);
CREATE INDEX idx_todos_done ON todos(done);

-- ============================================================================
-- REMINDERS (with family isolation)
-- ============================================================================

CREATE TABLE IF NOT EXISTS reminders (
  id SERIAL PRIMARY KEY,
  creator_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('one_off', 'recurring')),
  fire_at_utc TIMESTAMPTZ,
  recurrence TEXT,
  next_fire_at_utc TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  last_fired_at TIMESTAMPTZ
);

CREATE INDEX idx_reminders_recipient_family ON reminders(recipient_user_id, family_id);
CREATE INDEX idx_reminders_family ON reminders(family_id);
CREATE INDEX idx_reminders_next_fire ON reminders(next_fire_at_utc) WHERE next_fire_at_utc IS NOT NULL;

-- ============================================================================
-- SCHEDULE STATE (per user)
-- ============================================================================

CREATE TABLE IF NOT EXISTS schedule_state (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  last_convo_end_utc TIMESTAMPTZ,
  last_daily_starter_date DATE,
  last_4h_nudge_date DATE,
  last_overdue_reminder_date DATE,
  last_daily_todos_date DATE
);

CREATE INDEX idx_schedule_state_user ON schedule_state(user_id);

-- ============================================================================
-- LLM LOG (request tracking)
-- ============================================================================

CREATE TABLE IF NOT EXISTS llm_log (
  id SERIAL PRIMARY KEY,
  request_id TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  family_id INTEGER REFERENCES families(id),
  owner TEXT NOT NULL DEFAULT 'default',
  step TEXT NOT NULL,
  request_doc JSONB,
  response_text TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_llm_log_request_id ON llm_log(request_id);
CREATE INDEX idx_llm_log_user ON llm_log(user_id);
CREATE INDEX idx_llm_log_family ON llm_log(family_id);
CREATE INDEX idx_llm_log_created_at ON llm_log(created_at);

-- ============================================================================
-- MODERATION FLAGS (content safety)
-- ============================================================================

CREATE TABLE IF NOT EXISTS moderation_flags (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  family_id INTEGER REFERENCES families(id),
  message TEXT NOT NULL,
  original_response TEXT,
  replacement_response TEXT,
  flags JSONB NOT NULL DEFAULT '{}'::jsonb,
  action TEXT NOT NULL CHECK (action IN ('blocked', 'replaced', 'flagged')),
  reviewed BOOLEAN NOT NULL DEFAULT false,
  reviewed_at TIMESTAMPTZ,
  reviewed_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_moderation_user_family ON moderation_flags(user_id, family_id);
CREATE INDEX idx_moderation_reviewed ON moderation_flags(reviewed);
CREATE INDEX idx_moderation_created_at ON moderation_flags(created_at);

-- ============================================================================
-- RATE LIMIT LOG (abuse tracking)
-- ============================================================================

CREATE TABLE IF NOT EXISTS rate_limit_log (
  id SERIAL PRIMARY KEY,
  family_id INTEGER NOT NULL REFERENCES families(id),
  user_id INTEGER REFERENCES users(id),
  message_count INTEGER NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  cooldown_until TIMESTAMPTZ,
  cooldown_level INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_rate_limit_family ON rate_limit_log(family_id);
CREATE INDEX idx_rate_limit_created_at ON rate_limit_log(created_at);

-- ============================================================================
-- SKILLS REGISTRY
-- ============================================================================

CREATE TABLE IF NOT EXISTS skills_registry (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  entrypoint TEXT NOT NULL,
  input_schema JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- ============================================================================
-- SKILLS ACCESS
-- ============================================================================

CREATE TABLE IF NOT EXISTS skills_access_default (
  skill_id TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS skills_access_by_user (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL,
  UNIQUE(user_id, skill_id)
);

CREATE INDEX idx_skills_access_user ON skills_access_by_user(user_id);

-- ============================================================================
-- CONFIG (global key-value settings)
-- ============================================================================

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ============================================================================
-- WATCH SELF REPLIED (deduplication)
-- ============================================================================

CREATE TABLE IF NOT EXISTS watch_self_replied (
  message_guid TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_watch_self_replied_created_at ON watch_self_replied(created_at);

-- ============================================================================
-- GROUP CHATS (Telegram group metadata)
-- ============================================================================

CREATE TABLE IF NOT EXISTS group_chats (
  chat_id TEXT PRIMARY KEY,
  family_id INTEGER REFERENCES families(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_group_chats_family ON group_chats(family_id);

-- ============================================================================
-- SYSTEM ADMIN FLAG
-- ============================================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_system_admin BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX idx_users_system_admin ON users(is_system_admin) WHERE is_system_admin = true;
