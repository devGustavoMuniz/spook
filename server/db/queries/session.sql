-- name: CreateSession :exec
INSERT INTO sessions (id, user_id, token_hash, user_agent, expires_at)
VALUES ($1, $2, $3, $4, $5);

-- name: GetSessionByTokenHash :one
SELECT id, user_id, expires_at, password_confirmed_at FROM sessions WHERE token_hash = $1;

-- name: DeleteSessionByTokenHash :exec
DELETE FROM sessions WHERE token_hash = $1;

-- name: DeleteExpiredSessions :execrows
DELETE FROM sessions WHERE expires_at < now();

-- name: ConfirmSessionPassword :exec
UPDATE sessions SET password_confirmed_at = $2 WHERE token_hash = $1;

-- name: DeleteOtherSessions :execrows
DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2;
