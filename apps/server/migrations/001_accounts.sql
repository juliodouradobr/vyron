-- Etapa 1: contas, sessões de login, códigos de recuperação e preferências.

CREATE TABLE users (
  id              uuid PRIMARY KEY,
  username        text NOT NULL,
  display_name    text NOT NULL,
  bio             text NOT NULL DEFAULT '',
  password_hash   text NOT NULL,
  status          text NOT NULL DEFAULT 'online'
                  CHECK (status IN ('online', 'idle', 'dnd', 'invisible')),
  failed_logins   integer NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_username_format CHECK (username ~ '^[a-z0-9_.]{2,32}$')
);
-- O nome já chega normalizado em minúsculas; o índice em lower() é uma garantia extra.
CREATE UNIQUE INDEX users_username_key ON users (lower(username));

-- Tokens opacos: o banco guarda apenas o SHA-256 do token, nunca o valor em si.
CREATE TABLE login_sessions (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,
  client_name   text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz
);
CREATE INDEX login_sessions_user_active_idx ON login_sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE recovery_codes (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_hash   text NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recovery_codes_user_idx ON recovery_codes (user_id) WHERE used_at IS NULL;

CREATE TABLE user_settings (
  user_id     uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
