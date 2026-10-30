-- Etapa 2: amizades, bloqueios, servidores, cargos, canais, mensagens, convites, auditoria.
-- IDs de mensagens e canais são UUIDv7 (ordenáveis por tempo), o que permite paginar por id.

-- Relações direcionais: (user_id → target_id).
--   friend: nos dois sentidos · outgoing/incoming: pedido pendente · blocked: só de quem bloqueou.
CREATE TABLE relationships (
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  target_id   uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type        text NOT NULL CHECK (type IN ('friend', 'outgoing', 'incoming', 'blocked')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, target_id),
  CHECK (user_id <> target_id)
);
CREATE INDEX relationships_target_idx ON relationships (target_id);

CREATE TABLE servers (
  id           uuid PRIMARY KEY,
  name         text NOT NULL,
  description  text NOT NULL DEFAULT '',
  owner_id     uuid NOT NULL REFERENCES users (id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE server_members (
  server_id  uuid NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  nickname   text,
  joined_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (server_id, user_id)
);
CREATE INDEX server_members_user_idx ON server_members (user_id);

-- O cargo padrão (@everyone) tem is_default = true e posição 0. Posição maior = mais alto na hierarquia.
CREATE TABLE roles (
  id           uuid PRIMARY KEY,
  server_id    uuid NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
  name         text NOT NULL,
  color        integer,
  permissions  bigint NOT NULL DEFAULT 0,
  position     integer NOT NULL DEFAULT 0,
  is_default   boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX roles_server_idx ON roles (server_id);
CREATE UNIQUE INDEX roles_one_default ON roles (server_id) WHERE is_default;

CREATE TABLE member_roles (
  server_id  uuid NOT NULL,
  user_id    uuid NOT NULL,
  role_id    uuid NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  PRIMARY KEY (server_id, user_id, role_id),
  FOREIGN KEY (server_id, user_id) REFERENCES server_members (server_id, user_id) ON DELETE CASCADE
);

-- Canais de servidor (server_id preenchido) e conversas privadas (type = 'dm', server_id nulo).
CREATE TABLE channels (
  id               uuid PRIMARY KEY,
  server_id        uuid REFERENCES servers (id) ON DELETE CASCADE,
  type             text NOT NULL CHECK (type IN ('category', 'text', 'voice', 'announcement', 'dm')),
  name             text NOT NULL DEFAULT '',
  topic            text NOT NULL DEFAULT '',
  parent_id        uuid REFERENCES channels (id) ON DELETE SET NULL,
  position         integer NOT NULL DEFAULT 0,
  last_message_id  uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((type = 'dm') = (server_id IS NULL))
);
CREATE INDEX channels_server_idx ON channels (server_id);

CREATE TABLE dm_recipients (
  channel_id  uuid NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX dm_recipients_user_idx ON dm_recipients (user_id);

CREATE TABLE channel_overwrites (
  channel_id   uuid NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  target_type  text NOT NULL CHECK (target_type IN ('role', 'member')),
  target_id    uuid NOT NULL,
  allow        bigint NOT NULL DEFAULT 0,
  deny         bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, target_id)
);

CREATE TABLE messages (
  id           uuid PRIMARY KEY,
  channel_id   uuid NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  author_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  content      text NOT NULL,
  reply_to_id  uuid REFERENCES messages (id) ON DELETE SET NULL,
  mentions     uuid[] NOT NULL DEFAULT '{}',
  -- Gerado pelo cliente: reenviar a mesma mensagem após falha de rede não a duplica.
  nonce        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  edited_at    timestamptz
);
CREATE INDEX messages_channel_idx ON messages (channel_id, id DESC);
CREATE UNIQUE INDEX messages_nonce_key ON messages (author_id, nonce) WHERE nonce IS NOT NULL;

CREATE TABLE reactions (
  message_id  uuid NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  emoji       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, emoji)
);

CREATE TABLE read_states (
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  channel_id    uuid NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  last_read_id  uuid,
  PRIMARY KEY (user_id, channel_id)
);

CREATE TABLE invites (
  code        text PRIMARY KEY,
  server_id   uuid NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
  inviter_id  uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  max_uses    integer NOT NULL DEFAULT 0,
  uses        integer NOT NULL DEFAULT 0,
  expires_at  timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invites_server_idx ON invites (server_id);

CREATE TABLE audit_log (
  id          uuid PRIMARY KEY,
  server_id   uuid NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
  actor_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  action      text NOT NULL,
  target_id   uuid,
  details     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_server_idx ON audit_log (server_id, id DESC);

CREATE TABLE reports (
  id           uuid PRIMARY KEY,
  reporter_id  uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  target_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  message_id   uuid REFERENCES messages (id) ON DELETE SET NULL,
  reason       text NOT NULL,
  details      text NOT NULL DEFAULT '',
  -- Cópia do conteúdo no momento da denúncia, para a moderação não depender da mensagem existir.
  snapshot     text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now()
);
