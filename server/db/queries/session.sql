-- name: CreateSession :exec
INSERT INTO sessions (id, user_id, token_hash, user_agent, expires_at, remember, last_seen_at)
VALUES ($1, $2, $3, $4, $5, $6, $7);

-- name: GetSessionByTokenHash :one
SELECT id, user_id, expires_at, password_confirmed_at, remember, last_seen_at, created_at
FROM sessions WHERE token_hash = $1;

-- name: DeleteSessionByTokenHash :exec
DELETE FROM sessions WHERE token_hash = $1;

-- name: DeleteExpiredSessions :execrows
DELETE FROM sessions WHERE expires_at < now();

-- name: ConfirmSessionPassword :exec
UPDATE sessions SET password_confirmed_at = $2 WHERE token_hash = $1;

-- name: DeleteOtherSessions :execrows
DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2;

-- Renovação deslizante: só grava se o último uso for mais velho que o limite (evita escrever a cada requisição).
-- name: SlideSession :execrows
UPDATE sessions SET last_seen_at = $2, expires_at = $3
WHERE token_hash = $1 AND last_seen_at <= sqlc.arg(stale_before);

-- name: ListActiveSessions :many
SELECT id, token_hash, user_agent, remember, created_at, last_seen_at, expires_at
FROM sessions WHERE user_id = $1 AND expires_at > now() ORDER BY last_seen_at DESC, id DESC;

-- name: DeleteSessionByID :one
DELETE FROM sessions WHERE id = $1 AND user_id = $2 RETURNING token_hash;
