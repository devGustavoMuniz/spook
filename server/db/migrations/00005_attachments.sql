-- +goose Up
-- Anexos (RF10). message_id fica NULL até a mensagem ser enviada; anexos órfãos (sem mensagem há mais de
-- 1 h) são apagados por um job periódico. O canal do anexo vem da chave do objeto
-- (attachments/<channel_id>/<id>/<nome>), então não há coluna channel_id (SPEC seção 6).
CREATE TABLE attachments (
    id            bigint PRIMARY KEY,
    message_id    bigint NULL REFERENCES messages (id) ON DELETE CASCADE,
    uploader_id   bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    object_key    text NOT NULL,
    filename      text NOT NULL,
    content_type  text NOT NULL,
    size_bytes    bigint NOT NULL,
    width         int NULL,
    height        int NULL,
    thumbnail_key text NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- Anexos de um lote de mensagens (histórico sem N+1).
CREATE INDEX attachments_message_id_idx ON attachments (message_id) WHERE message_id IS NOT NULL;
-- Pendentes por usuário (limite de pendentes e validação do envio) e varredura de órfãos.
CREATE INDEX attachments_uploader_pending_idx ON attachments (uploader_id, created_at) WHERE message_id IS NULL;
CREATE INDEX attachments_orphans_idx ON attachments (created_at) WHERE message_id IS NULL;

-- +goose Down
DROP TABLE attachments;
