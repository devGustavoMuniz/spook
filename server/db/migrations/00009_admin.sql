-- +goose Up
-- Painel administrativo (/admin, adicional fora do SPEC). Aditiva.
-- is_admin: quem pode usar /api/admin/**. Promovido por ADMIN_USERNAMES no boot (ver SPEC 5.5).
ALTER TABLE users ADD COLUMN is_admin boolean NOT NULL DEFAULT false;

-- O painel conta/ordena usuários por mensagens enviadas; sem este índice isso varreria `messages`.
CREATE INDEX messages_author_id_idx ON messages (author_id);

-- +goose Down
DROP INDEX messages_author_id_idx;
ALTER TABLE users DROP COLUMN is_admin;
