-- +goose Up
-- Chamados de feedback, sugestões e bugs (adicional fora do SPEC). Aditiva: tabelas novas.
-- tickets: um chamado aberto por um usuário; o admin responde pelo /admin. status segue o fluxo
-- open -> in_review -> answered -> resolved/closed. user_unread = o admin respondeu e o autor ainda não abriu.
CREATE TABLE tickets (
    id               bigint      PRIMARY KEY,
    author_id        bigint      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    kind             text        NOT NULL CHECK (kind IN ('bug', 'suggestion', 'feedback')),
    status           text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_review', 'answered', 'resolved', 'closed')),
    title            text        NOT NULL CHECK (char_length(title) BETWEEN 3 AND 120),
    context          jsonb       NULL CHECK (context IS NULL OR octet_length(context::text) <= 2048),
    message_count    int         NOT NULL DEFAULT 0,
    user_unread      boolean     NOT NULL DEFAULT false,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    last_activity_at timestamptz NOT NULL DEFAULT now()
);
-- "Meus chamados" (cursor por atividade) e a fila do admin (filtros por status e tipo, ordenados por atividade).
CREATE INDEX tickets_author_activity_idx ON tickets (author_id, last_activity_at DESC, id DESC);
CREATE INDEX tickets_status_activity_idx ON tickets (status, last_activity_at DESC, id DESC);
CREATE INDEX tickets_activity_idx ON tickets (last_activity_at DESC, id DESC);
CREATE INDEX tickets_kind_idx ON tickets (kind);

-- ticket_messages: kind = user (autor), admin (resposta pública) ou internal (nota só dos admins).
-- author_id vira NULL se a conta de quem escreveu for excluída (a conversa continua para o outro lado).
CREATE TABLE ticket_messages (
    id         bigint      PRIMARY KEY,
    ticket_id  bigint      NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
    author_id  bigint      NULL REFERENCES users (id) ON DELETE SET NULL,
    kind       text        NOT NULL CHECK (kind IN ('user', 'admin', 'internal')),
    body       text        NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ticket_messages_ticket_idx ON ticket_messages (ticket_id, id);
CREATE INDEX ticket_messages_author_idx ON ticket_messages (author_id);

-- +goose Down
DROP TABLE ticket_messages;
DROP TABLE tickets;
