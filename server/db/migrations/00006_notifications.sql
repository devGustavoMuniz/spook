-- +goose Up
-- Notificações (Fase 6b): estado de leitura por usuário e canal, inscrições de Web Push e as menções
-- resolvidas de cada mensagem. Aditiva: nenhuma tabela existente perde coluna.

-- read_states: sem linha = "nada lido além da entrada no servidor" (baseline calculado na consulta).
CREATE TABLE read_states (
    user_id              bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    channel_id           bigint NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    last_read_message_id bigint NOT NULL,
    mention_count        int    NOT NULL DEFAULT 0 CHECK (mention_count >= 0),
    PRIMARY KEY (user_id, channel_id)
);
-- A PK cobre "estados de um usuário"; este índice serve ao ON DELETE CASCADE do canal.
CREATE INDEX read_states_channel_id_idx ON read_states (channel_id);

CREATE TABLE push_subscriptions (
    id         bigint PRIMARY KEY,
    user_id    bigint      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    endpoint   text        NOT NULL UNIQUE,
    p256dh     text        NOT NULL,
    auth       text        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX push_subscriptions_user_id_idx ON push_subscriptions (user_id);

-- IDs dos usuários mencionados (@username) na criação da mensagem; o histórico devolve o mesmo que o
-- MESSAGE_CREATE entregou. O default constante não reescreve a tabela.
ALTER TABLE messages ADD COLUMN mention_ids bigint[] NOT NULL DEFAULT '{}';

-- Menor ID Snowflake de um instante (época 2026-01-01T00:00:00Z = 1767225600000 ms, 22 bits de nó e
-- sequência): a base das não lidas de quem entrou no servidor depois das mensagens antigas. Precisa
-- ficar igual a internal/platform/snowflake (um teste de integração confere).
-- +goose StatementBegin
CREATE FUNCTION snowflake_floor(ts timestamptz) RETURNS bigint
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$ SELECT (floor(extract(epoch FROM ts) * 1000)::bigint - 1767225600000) << 22 $$;
-- +goose StatementEnd

-- +goose Down
DROP FUNCTION snowflake_floor(timestamptz);
ALTER TABLE messages DROP COLUMN mention_ids;
DROP TABLE push_subscriptions;
DROP TABLE read_states;
