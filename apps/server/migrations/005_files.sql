-- Arquivos enviados: anexos de mensagens, avatares e banners.
-- O conteúdo fica no armazenamento de arquivos (disco/objeto); aqui só os metadados e o vínculo de acesso.
-- Anexo sem message_id = enviado mas ainda não usado (some sozinho depois de um tempo).

CREATE TABLE files (
  id            uuid PRIMARY KEY,
  owner_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('attachment', 'avatar', 'banner')),
  channel_id    uuid REFERENCES channels (id) ON DELETE CASCADE,
  message_id    uuid REFERENCES messages (id) ON DELETE CASCADE,
  filename      text NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 255),
  content_type  text NOT NULL,
  size          integer NOT NULL CHECK (size > 0),
  width         integer,
  height        integer,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT files_attachment_channel CHECK (kind <> 'attachment' OR channel_id IS NOT NULL)
);
CREATE INDEX files_message_idx ON files (message_id) WHERE message_id IS NOT NULL;
CREATE INDEX files_pending_idx ON files (owner_id, created_at) WHERE kind = 'attachment' AND message_id IS NULL;

ALTER TABLE users ADD COLUMN avatar_id uuid REFERENCES files (id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN banner_id uuid REFERENCES files (id) ON DELETE SET NULL;
