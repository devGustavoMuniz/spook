-- name: CreateSession :exec
INSERT INTO sessions (id, user_id, token_hash, user_agent, expires_at)
VALUES ($1, $2, $3, $4, $5);

-- name: GetSessionByTokenHash :one
SELECT user_id, expires_at FROM sessions WHERE token_hash = $1;

-- name: DeleteSessionByTokenHash :exec
DELETE FROM sessions WHERE token_hash = $1;

-- name: DeleteExpiredSessions :execrows
DELETE FROM sessions WHERE expires_at < now();
