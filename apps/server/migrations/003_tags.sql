-- VYRON: identificador público Name#00000.
-- O nome deixa de ser único sozinho; o par (nome sem distinção de maiúsculas, discriminador) é único.
-- O discriminador é sorteado pelo servidor (1–99999, sempre exibido com 5 dígitos).

ALTER TABLE users DROP CONSTRAINT users_username_format;
DROP INDEX users_username_key;

ALTER TABLE users ADD COLUMN discriminator char(5);

-- Contas existentes: os nomes já eram únicos, então qualquer número serve sem colisão.
UPDATE users SET discriminator = lpad((floor(random() * 99999) + 1)::int::text, 5, '0') WHERE discriminator IS NULL;

ALTER TABLE users ALTER COLUMN discriminator SET NOT NULL;
ALTER TABLE users ADD CONSTRAINT users_discriminator_format CHECK (discriminator ~ '^[0-9]{5}$' AND discriminator <> '00000');
-- Nome: 2–32 caracteres, sem espaços, sem "#" (separador do identificador) e sem "@" (menções).
ALTER TABLE users ADD CONSTRAINT users_username_format CHECK (char_length(username) BETWEEN 2 AND 32 AND username !~ '[[:space:]#@]');

CREATE UNIQUE INDEX users_tag_key ON users (lower(username), discriminator);
CREATE INDEX users_name_idx ON users (lower(username));
