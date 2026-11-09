-- Nitro e Nitro+ (feature entitlement).

-- Trava a linha do usuário (sem bloquear leituras nem inserts de FK) para serializar resgates e concessões dele.
-- name: LockUserForEntitlement :one
SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL FOR NO KEY UPDATE;

-- name: EntitlementUserExists :one
SELECT id, username, display_name FROM users WHERE id = $1 AND deleted_at IS NULL;

-- name: InsertEntitlement :one
INSERT INTO entitlements (id, user_id, tier, source, expires_at, granted_by, redeem_code_id)
VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING *;

-- Concessões que ainda não foram revogadas (vencidas ou não: quem decide é plan.Effective, com o relógio do service).
-- name: ListLiveEntitlementsByUser :many
SELECT * FROM entitlements WHERE user_id = $1 AND revoked_at IS NULL;

-- Revoga as concessões ativas da pessoa (não revogadas e não vencidas em now).
-- name: RevokeActiveEntitlementsByUser :many
UPDATE entitlements SET revoked_at = sqlc.arg(now)
WHERE user_id = sqlc.arg(user_id) AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > sqlc.arg(now))
RETURNING *;

-- name: RevokeEntitlementByID :one
UPDATE entitlements SET revoked_at = sqlc.arg(now)
WHERE id = sqlc.arg(id) AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > sqlc.arg(now))
RETURNING *;

-- Lista do /admin: filtro por estado (active | inactive | all), plano e busca por username/nome; paginação por página.
-- name: AdminListEntitlements :many
SELECT e.id, e.user_id, e.tier, e.source, e.expires_at, e.revoked_at, e.created_at,
       u.username, u.display_name,
       g.username AS granted_by_username,
       (e.revoked_at IS NULL AND (e.expires_at IS NULL OR e.expires_at > sqlc.arg(now)))::boolean AS active,
       count(*) OVER ()::bigint AS total
FROM entitlements e
JOIN users u ON u.id = e.user_id
LEFT JOIN users g ON g.id = e.granted_by
WHERE (sqlc.arg(state)::text = 'all'
        OR (sqlc.arg(state)::text = 'active' AND e.revoked_at IS NULL AND (e.expires_at IS NULL OR e.expires_at > sqlc.arg(now)))
        OR (sqlc.arg(state)::text = 'inactive' AND NOT (e.revoked_at IS NULL AND (e.expires_at IS NULL OR e.expires_at > sqlc.arg(now)))))
  AND (sqlc.arg(tier)::text = '' OR e.tier = sqlc.arg(tier)::text)
  AND (sqlc.arg(q)::text = '' OR u.username ILIKE '%' || sqlc.arg(q)::text || '%' OR u.display_name ILIKE '%' || sqlc.arg(q)::text || '%')
ORDER BY e.created_at DESC, e.id DESC
LIMIT sqlc.arg(page_size) OFFSET sqlc.arg(page_offset);

-- Job de vencimento: concessões finitas já vencidas e ainda não avisadas, marcadas na mesma instrução (um job por
-- vez; se dois rodarem juntos, cada concessão sai para um só). Devolve quem precisa ter o plano reavaliado.
-- name: ClaimExpiredEntitlements :many
UPDATE entitlements SET expiry_notified_at = sqlc.arg(now)
WHERE id IN (
    SELECT x.id FROM entitlements x
    WHERE x.revoked_at IS NULL AND x.expiry_notified_at IS NULL AND x.expires_at IS NOT NULL AND x.expires_at <= sqlc.arg(now)
    ORDER BY x.expires_at
    LIMIT sqlc.arg(max_rows) FOR UPDATE SKIP LOCKED
)
RETURNING id, user_id, tier, source;

-- ---- códigos de resgate ----

-- name: InsertRedeemCode :one
INSERT INTO redeem_codes (id, code_hash, code_hint, tier, days, created_by, expires_at)
VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING *;

-- Resgate atômico: só um UPDATE vence a corrida; sem linha = inexistente, já usado ou vencido (o service distingue).
-- name: ClaimRedeemCode :one
UPDATE redeem_codes SET redeemed_by = sqlc.arg(user_id), redeemed_at = sqlc.arg(now)
WHERE code_hash = sqlc.arg(code_hash) AND redeemed_by IS NULL AND (expires_at IS NULL OR expires_at > sqlc.arg(now))
RETURNING *;

-- name: GetRedeemCodeByHash :one
SELECT * FROM redeem_codes WHERE code_hash = $1;

-- name: AdminListRedeemCodes :many
SELECT c.id, c.code_hint, c.tier, c.days, c.created_at, c.redeemed_at, c.expires_at,
       cb.username AS created_by_username, rb.username AS redeemed_by_username,
       count(*) OVER ()::bigint AS total
FROM redeem_codes c
LEFT JOIN users cb ON cb.id = c.created_by
LEFT JOIN users rb ON rb.id = c.redeemed_by
WHERE (sqlc.arg(state)::text = 'all'
        OR (sqlc.arg(state)::text = 'used' AND c.redeemed_at IS NOT NULL)
        OR (sqlc.arg(state)::text = 'unused' AND c.redeemed_at IS NULL AND (c.expires_at IS NULL OR c.expires_at > sqlc.arg(now)))
        OR (sqlc.arg(state)::text = 'expired' AND c.redeemed_at IS NULL AND c.expires_at IS NOT NULL AND c.expires_at <= sqlc.arg(now)))
  AND (sqlc.arg(tier)::text = '' OR c.tier = sqlc.arg(tier)::text)
ORDER BY c.created_at DESC, c.id DESC
LIMIT sqlc.arg(page_size) OFFSET sqlc.arg(page_offset);
