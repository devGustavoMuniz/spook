-- +goose Up
-- Participantes de DMs (canais tipo 3 e 4). O dono da DM em grupo fica em channels.owner_id.
CREATE TABLE channel_recipients (
    channel_id bigint NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    user_id    bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX channel_recipients_user_id_idx ON channel_recipients (user_id);

-- Unicidade da DM 1:1 por par de usuários, valendo mesmo sob corrida: o par ordenado (user_a < user_b)
-- é a chave primária, então duas criações simultâneas disputam a mesma linha e só uma vence.
CREATE TABLE dm_pairs (
    user_a     bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    user_b     bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    channel_id bigint NOT NULL UNIQUE REFERENCES channels (id) ON DELETE CASCADE,
    PRIMARY KEY (user_a, user_b),
    CHECK (user_a < user_b)
);

-- +goose Down
DROP TABLE dm_pairs;
DROP TABLE channel_recipients;
