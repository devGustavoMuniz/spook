-- Login social (feature social).

-- name: GetSocialAccount :one
SELECT id, user_id, provider, provider_user_id, email, created_at
FROM social_accounts WHERE provider = $1 AND provider_user_id = $2;

-- name: ListSocialAccountsByUser :many
SELECT id, user_id, provider, provider_user_id, email, created_at
FROM social_accounts WHERE user_id = $1 ORDER BY created_at;

-- name: InsertSocialAccount :exec
INSERT INTO social_accounts (id, user_id, provider, provider_user_id, email)
VALUES ($1, $2, $3, $4, $5);

-- name: DeleteSocialAccount :execrows
DELETE FROM social_accounts WHERE user_id = $1 AND provider = $2;

-- name: CreateSocialUser :one
INSERT INTO users (id, email, username, display_name, password_hash, email_verified_at)
VALUES ($1, $2, $3, $4, '!', now())
RETURNING id, email, username, display_name, created_at, is_admin;

-- name: UserHasPassword :one
SELECT password_hash <> '!' FROM users WHERE id = $1 AND deleted_at IS NULL;

-- name: InsertSocialSignup :exec
INSERT INTO social_signups (token_hash, provider, provider_user_id, email, display_name, suggested, expires_at)
VALUES ($1, $2, $3, $4, $5, $6, $7);

-- name: GetSocialSignup :one
SELECT token_hash, provider, provider_user_id, email, display_name, suggested, expires_at
FROM social_signups WHERE token_hash = $1 AND expires_at > now();

-- name: DeleteSocialSignup :execrows
DELETE FROM social_signups WHERE token_hash = $1;

-- name: DeleteExpiredSocialSignups :execrows
DELETE FROM social_signups WHERE expires_at < now();

-- Vínculo automático pelo e-mail verificado do provedor (SPEC 7.4): trava a conta do e-mail (sem diferença de
-- caixa: a coluna é citext) para vincular e, se o e-mail ainda não estava verificado, verificar na mesma transação.
-- name: LockUserByEmailForLink :one
SELECT id, email_verified_at FROM users WHERE email = $1 AND deleted_at IS NULL FOR UPDATE;

-- name: MarkUserEmailVerifiedForLink :exec
UPDATE users SET email_verified_at = now(), pending_email = NULL WHERE id = $1;

-- name: InvalidateOpenEmailTokens :exec
UPDATE email_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL;

-- name: DeleteAllUserSessionsForLink :execrows
DELETE FROM sessions WHERE user_id = $1;
