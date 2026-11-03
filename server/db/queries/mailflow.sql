-- Fluxos por e-mail (feature mailflow): verificação, troca de e-mail e recuperação de senha.

-- name: InsertEmailToken :exec
INSERT INTO email_tokens (id, user_id, kind, email, token_hash, expires_at)
VALUES ($1, $2, $3, $4, $5, $6);

-- name: InvalidateEmailTokens :exec
UPDATE email_tokens SET used_at = now() WHERE user_id = $1 AND kind = $2 AND used_at IS NULL;

-- name: GetEmailTokenByHash :one
SELECT id, user_id, kind, email, expires_at, used_at FROM email_tokens WHERE token_hash = $1;

-- Consome o token: só uma chamada vence a corrida (uso único).
-- name: ConsumeEmailToken :one
UPDATE email_tokens SET used_at = now()
WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
RETURNING id, user_id, kind, email;

-- name: GetEmailTokenForSend :one
SELECT id, user_id, kind, email, expires_at, used_at, sent_at FROM email_tokens WHERE id = $1;

-- name: MarkEmailTokenSent :exec
UPDATE email_tokens SET sent_at = now() WHERE id = $1;

-- name: DeleteExpiredEmailTokens :execrows
DELETE FROM email_tokens WHERE expires_at < now() - interval '1 day';

-- name: SetUserEmailVerified :exec
UPDATE users SET email_verified_at = now() WHERE id = $1 AND deleted_at IS NULL AND email_verified_at IS NULL;

-- name: SetUserPendingEmail :exec
UPDATE users SET pending_email = $2 WHERE id = $1 AND deleted_at IS NULL;

-- Confirma a troca: o endereço novo vale e já fica verificado.
-- name: ApplyUserEmailChange :one
UPDATE users SET email = $2, email_verified_at = now(), pending_email = NULL
WHERE id = $1 AND deleted_at IS NULL
RETURNING id, email;

-- name: GetUserByEmailForFlow :one
SELECT id, email, email_verified_at FROM users WHERE email = $1 AND deleted_at IS NULL;

-- name: CountSocialAccountsByUser :one
SELECT count(*) FROM social_accounts WHERE user_id = $1;

-- name: AdminFindUserForReset :one
SELECT id, email, username FROM users WHERE username = $1 AND deleted_at IS NULL;
