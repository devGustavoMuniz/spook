-- +goose Up
-- Anexos (capturas de tela) dos chamados (adicional fora do SPEC). Aditiva: tabela nova.
-- message_id fica NULL até a mensagem do chamado ser gravada; anexos órfãos (sem mensagem há mais de 1 h) são
-- apagados por um job periódico. ticket_id NÃO tem FK de propósito: ao abrir um chamado o cliente envia as imagens
-- antes de o chamado existir, usando um ID de rascunho reservado pelo servidor (que vira o ID do chamado). A remoção
-- em cascata vem de message_id (chamado -> mensagens -> anexos).
CREATE TABLE ticket_attachments (
    id           bigint      PRIMARY KEY,
    ticket_id    bigint      NOT NULL,
    message_id   bigint      NULL REFERENCES ticket_messages (id) ON DELETE CASCADE,
    uploader_id  bigint      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    object_key   text        NOT NULL,
    filename     text        NOT NULL,
    content_type text        NOT NULL,
    size_bytes   bigint      NOT NULL CHECK (size_bytes > 0),
    created_at   timestamptz NOT NULL DEFAULT now()
);
-- Anexos de um chamado (a conversa inteira numa consulta só).
CREATE INDEX ticket_attachments_ticket_idx ON ticket_attachments (ticket_id) WHERE message_id IS NOT NULL;
CREATE INDEX ticket_attachments_message_idx ON ticket_attachments (message_id) WHERE message_id IS NOT NULL;
-- Pendentes por usuário (limite de pendentes e validação do envio) e varredura de órfãos.
CREATE INDEX ticket_attachments_pending_idx ON ticket_attachments (uploader_id, created_at) WHERE message_id IS NULL;
CREATE INDEX ticket_attachments_orphans_idx ON ticket_attachments (created_at) WHERE message_id IS NULL;

-- +goose Down
DROP TABLE ticket_attachments;
