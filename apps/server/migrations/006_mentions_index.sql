-- Caixa de menções: "mensagens em que fui mencionado" sem varrer a tabela inteira.
CREATE INDEX messages_mentions_idx ON messages USING GIN (mentions);
