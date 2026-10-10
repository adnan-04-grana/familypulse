CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  email TEXT NOT NULL UNIQUE,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_iterations INTEGER NOT NULL DEFAULT 600000,
  medical_id TEXT NOT NULL UNIQUE,
  profile JSONB NOT NULL DEFAULT '{}'::jsonb,
  profile_saved BOOLEAN NOT NULL DEFAULT FALSE,
  permissions JSONB NOT NULL DEFAULT '{"basic":false,"medical":false,"emergency":false,"location":false}'::jsonb,
  contacts JSONB NOT NULL DEFAULT '[]'::jsonb,
  share_location BOOLEAN NOT NULL DEFAULT FALSE,
  active_circle_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE IF NOT EXISTS circles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  escalation_minutes INTEGER NOT NULL DEFAULT 5 CHECK (escalation_minutes IN (2, 5, 10, 15)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_active_circle_id_fkey;
ALTER TABLE accounts ADD CONSTRAINT accounts_active_circle_id_fkey
  FOREIGN KEY (active_circle_id) REFERENCES circles(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS circle_members (
  circle_id TEXT NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (circle_id, account_id)
);

CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  circle_id TEXT NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  consumed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS safety_events (
  id TEXT NOT NULL,
  circle_id TEXT NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'responding', 'resolved', 'cancelled')),
  created_at BIGINT NOT NULL,
  response_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  PRIMARY KEY (id, circle_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  read BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS locations (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  latitude DOUBLE PRECISION NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  accuracy DOUBLE PRECISION NOT NULL CHECK (accuracy >= 0),
  updated_at BIGINT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS email_tokens (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('verify-email', 'reset-password')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id BIGSERIAL PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS circle_members_account_idx ON circle_members(account_id);
CREATE INDEX IF NOT EXISTS safety_events_circle_created_idx ON safety_events(circle_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_account_created_idx ON notifications(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sessions_account_idx ON sessions(account_id);
CREATE INDEX IF NOT EXISTS email_tokens_account_purpose_idx ON email_tokens(account_id, purpose, expires_at);
CREATE INDEX IF NOT EXISTS push_subscriptions_account_idx ON push_subscriptions(account_id);