-- +goose Up
-- Social (adicional fora do SPEC): amizades e bloqueios. Aditiva: só tabelas novas.

-- Amizade entre duas pessoas: o par fica ordenado (user_a < user_b), então só existe uma linha por par,
-- mesmo sob corrida. pending = pedido enviado por requested_by; accepted = amigos.
CREATE TABLE friendships (
    user_a       bigint      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    user_b       bigint      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    status       text        NOT NULL CHECK (status IN ('pending', 'accepted')),
    requested_by bigint      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at   timestamptz NOT NULL DEFAULT now(),
    accepted_at  timestamptz NULL,
    PRIMARY KEY (user_a, user_b),
    CHECK (user_a < user_b),
    CHECK (requested_by IN (user_a, user_b)),
    CHECK ((status = 'accepted') = (accepted_at IS NOT NULL))
);
CREATE INDEX friendships_user_b_idx ON friendships (user_b);

-- Bloqueio: blocker_id bloqueou blocked_id. É unidirecional na tabela; os efeitos (DM, chamada) valem nos dois sentidos.
CREATE TABLE blocks (
    blocker_id bigint      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    blocked_id bigint      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (blocker_id, blocked_id),
    CHECK (blocker_id <> blocked_id)
);
CREATE INDEX blocks_blocked_id_idx ON blocks (blocked_id);

-- Visão por usuário: cada amizade aparece uma vez para cada lado (user_id = quem consulta) e cada bloqueio
-- para quem bloqueou. kind: friend, incoming (pedido recebido), outgoing (pedido enviado) ou blocked.
CREATE VIEW user_relationships AS
SELECT user_a AS user_id, user_b AS other_id,
       CASE WHEN status = 'accepted' THEN 'friend' WHEN requested_by = user_a THEN 'outgoing' ELSE 'incoming' END::text AS kind,
       COALESCE(accepted_at, created_at) AS since
FROM friendships
UNION ALL
SELECT user_b, user_a,
       CASE WHEN status = 'accepted' THEN 'friend' WHEN requested_by = user_b THEN 'outgoing' ELSE 'incoming' END::text,
       COALESCE(accepted_at, created_at)
FROM friendships
UNION ALL
SELECT blocker_id, blocked_id, 'blocked'::text, created_at FROM blocks;

-- +goose Down
DROP VIEW user_relationships;
DROP TABLE blocks;
DROP TABLE friendships;
