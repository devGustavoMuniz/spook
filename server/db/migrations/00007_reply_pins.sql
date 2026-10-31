-- +goose Up
-- Responder e fixar mensagens (adicional fora do SPEC). Aditiva: só colunas NULL (sem default, então o
-- Postgres não reescreve a tabela) e um índice parcial pequeno.
--
-- reference_id: mensagem respondida. Sem FK de propósito: a original pode ser apagada (soft delete) ou
-- sumir com o canal sem travar nada; o envio valida que ela existe, não está apagada e é do mesmo canal.
ALTER TABLE messages ADD COLUMN reference_id bigint NULL;
ALTER TABLE messages ADD COLUMN pinned_at timestamptz NULL;
ALTER TABLE messages ADD COLUMN pinned_by bigint NULL;

-- Lista de fixadas de um canal (a mais recente primeiro); só indexa as linhas fixadas.
CREATE INDEX messages_channel_pinned_idx ON messages (channel_id, pinned_at DESC) WHERE pinned_at IS NOT NULL;

-- +goose Down
DROP INDEX messages_channel_pinned_idx;
ALTER TABLE messages DROP COLUMN pinned_by;
ALTER TABLE messages DROP COLUMN pinned_at;
ALTER TABLE messages DROP COLUMN reference_id;
