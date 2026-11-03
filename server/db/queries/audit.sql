-- name: InsertAuditLog :exec
INSERT INTO audit_logs (id, guild_id, actor_id, action, target_type, target_id, reason, changes)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8);

-- name: ListAuditLogs :many
SELECT l.id, l.guild_id, l.actor_id, l.action, l.target_type, l.target_id, l.reason, l.changes, l.created_at,
       u.username AS actor_username, u.display_name AS actor_display_name, u.avatar_key AS actor_avatar_key
FROM audit_logs l
LEFT JOIN users u ON u.id = l.actor_id
WHERE l.guild_id = $1
  AND (sqlc.narg('action')::text IS NULL OR l.action = sqlc.narg('action')::text)
  AND (sqlc.narg('actor')::bigint IS NULL OR l.actor_id = sqlc.narg('actor')::bigint)
  AND (sqlc.narg('before')::bigint IS NULL OR l.id < sqlc.narg('before')::bigint)
ORDER BY l.id DESC
LIMIT $2;

-- Apaga em lotes (retenção): remove até $2 linhas anteriores a $1.
-- name: DeleteAuditLogsBefore :execrows
DELETE FROM audit_logs WHERE id IN (SELECT a.id FROM audit_logs a WHERE a.created_at < $1 ORDER BY a.id LIMIT $2);
