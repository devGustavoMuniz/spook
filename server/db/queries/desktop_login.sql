-- Login do desktop pelo navegador (handoff PKCE, feature auth).

-- name: InsertDesktopLoginCode :exec
INSERT INTO desktop_login_codes (code_hash, user_id, code_challenge, expires_at) VALUES ($1, $2, $3, $4);

-- Consome o código: uso único e dentro do prazo (a corrida é decidida pelo UPDATE).
-- name: ConsumeDesktopLoginCode :one
UPDATE desktop_login_codes SET used_at = now()
WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()
RETURNING user_id, code_challenge;

-- name: DeleteExpiredDesktopLoginCodes :execrows
DELETE FROM desktop_login_codes WHERE expires_at < now() - interval '1 hour';
