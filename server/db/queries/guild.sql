-- name: LockUser :one
SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE;

-- name: InsertGuild :one
INSERT INTO guilds (id, name, owner_id) VALUES ($1, $2, $3)
RETURNING *;

-- name: GetGuild :one
SELECT * FROM guilds WHERE id = $1;

-- name: ListGuildsByUser :many
SELECT g.* FROM guilds g
JOIN guild_members m ON m.guild_id = g.id
WHERE m.user_id = $1
ORDER BY m.joined_at, g.id;

-- name: CountGuildsByUser :one
SELECT count(*) FROM guild_members WHERE user_id = $1;

-- name: UpdateGuild :one
UPDATE guilds SET name = $2, icon_key = $3, system_channel_id = $4, system_join_enabled = $5 WHERE id = $1
RETURNING *;

-- name: DeleteGuild :execrows
DELETE FROM guilds WHERE id = $1;

-- name: UpdateGuildOwner :exec
UPDATE guilds SET owner_id = $2 WHERE id = $1;

-- name: InsertMember :execrows
INSERT INTO guild_members (guild_id, user_id) VALUES ($1, $2)
ON CONFLICT DO NOTHING;

-- name: DeleteMember :execrows
DELETE FROM guild_members WHERE guild_id = $1 AND user_id = $2;

-- name: IsMember :one
SELECT EXISTS (SELECT 1 FROM guild_members WHERE guild_id = $1 AND user_id = $2);

-- name: CountMembers :one
SELECT count(*) FROM guild_members WHERE guild_id = $1;

-- name: ListMembers :many
SELECT m.guild_id, m.user_id, m.nickname, m.joined_at, m.voice_muted,
       u.username, u.display_name, u.avatar_key, u.bio, u.pronouns, u.banner_key, u.banner_color,
       COALESCE(array_agg(mr.role_id) FILTER (WHERE mr.role_id IS NOT NULL), '{}')::bigint[] AS role_ids
FROM guild_members m
JOIN users u ON u.id = m.user_id
LEFT JOIN member_roles mr ON mr.guild_id = m.guild_id AND mr.user_id = m.user_id
WHERE m.guild_id = $1 AND m.user_id > $2
GROUP BY m.guild_id, m.user_id, u.id
ORDER BY m.user_id
LIMIT $3;

-- name: GetMember :one
SELECT m.guild_id, m.user_id, m.nickname, m.joined_at, m.voice_muted,
       u.username, u.display_name, u.avatar_key, u.bio, u.pronouns, u.banner_key, u.banner_color,
       COALESCE(array_agg(mr.role_id) FILTER (WHERE mr.role_id IS NOT NULL), '{}')::bigint[] AS role_ids
FROM guild_members m
JOIN users u ON u.id = m.user_id
LEFT JOIN member_roles mr ON mr.guild_id = m.guild_id AND mr.user_id = m.user_id
WHERE m.guild_id = $1 AND m.user_id = $2
GROUP BY m.guild_id, m.user_id, u.id;

-- Permissão efetiva do membro em uma consulta: OR do @everyone (id = guild_id) e dos cargos dele.
-- name: GetMemberAccess :one
SELECT g.owner_id,
       COALESCE(bit_or(r.permissions), 0)::bigint AS permissions,
       COALESCE(max(r.position), 0)::int AS highest_position,
       COALESCE((SELECT array_agg(mr.role_id) FROM member_roles mr WHERE mr.guild_id = g.id AND mr.user_id = $2), '{}')::bigint[] AS role_ids
FROM guilds g
JOIN guild_members m ON m.guild_id = g.id AND m.user_id = $2
LEFT JOIN roles r ON r.guild_id = g.id
     AND (r.id = g.id OR r.id IN (SELECT mr.role_id FROM member_roles mr WHERE mr.guild_id = g.id AND mr.user_id = $2))
WHERE g.id = $1
GROUP BY g.id, g.owner_id;

-- name: ListAccessByUser :many
SELECT g.id AS guild_id, g.owner_id,
       COALESCE(bit_or(r.permissions), 0)::bigint AS permissions,
       COALESCE(max(r.position), 0)::int AS highest_position
FROM guild_members m
JOIN guilds g ON g.id = m.guild_id
LEFT JOIN roles r ON r.guild_id = g.id
     AND (r.id = g.id OR r.id IN (SELECT mr.role_id FROM member_roles mr WHERE mr.guild_id = g.id AND mr.user_id = m.user_id))
WHERE m.user_id = $1
GROUP BY g.id, g.owner_id;

-- Membros do servidor com o necessário para a permissão efetiva e os cargos (menções em massa).
-- name: ListGuildMemberAccess :many
SELECT m.user_id, g.owner_id,
       COALESCE(bit_or(r.permissions), 0)::bigint AS permissions,
       COALESCE(max(r.position), 0)::int AS highest_position,
       COALESCE((SELECT array_agg(mr.role_id) FROM member_roles mr WHERE mr.guild_id = g.id AND mr.user_id = m.user_id), '{}')::bigint[] AS role_ids
FROM guild_members m
JOIN guilds g ON g.id = m.guild_id
LEFT JOIN roles r ON r.guild_id = g.id
     AND (r.id = g.id OR r.id IN (SELECT mr.role_id FROM member_roles mr WHERE mr.guild_id = g.id AND mr.user_id = m.user_id))
WHERE m.guild_id = $1
GROUP BY m.user_id, g.id, g.owner_id
ORDER BY m.user_id;

-- name: ListMemberRolesByUser :many
SELECT guild_id, role_id FROM member_roles WHERE user_id = $1;

-- name: ListRolesByGuild :many
SELECT * FROM roles WHERE guild_id = $1 ORDER BY position DESC, id;

-- name: ListRolesByGuilds :many
SELECT * FROM roles WHERE guild_id = ANY($1::bigint[]) ORDER BY guild_id, position DESC, id;

-- name: GetRole :one
SELECT * FROM roles WHERE id = $1 AND guild_id = $2;

-- name: InsertRole :one
INSERT INTO roles (id, guild_id, name, color, position, permissions, mentionable) VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING *;

-- name: UpdateRole :one
UPDATE roles SET name = $3, color = $4, position = $5, permissions = $6, mentionable = $7 WHERE id = $1 AND guild_id = $2
RETURNING *;

-- name: DeleteRole :execrows
DELETE FROM roles WHERE id = $1 AND guild_id = $2;

-- name: InsertMemberRole :execrows
INSERT INTO member_roles (guild_id, user_id, role_id) VALUES ($1, $2, $3)
ON CONFLICT DO NOTHING;

-- name: DeleteMemberRole :execrows
DELETE FROM member_roles WHERE guild_id = $1 AND user_id = $2 AND role_id = $3;

-- Canal das mensagens de entrada: o configurado (se ainda for um canal de texto do servidor) ou o primeiro canal
-- de texto. enabled = false: nenhuma mensagem de entrada.
-- name: GetSystemChannel :one
SELECT g.system_join_enabled AS enabled,
       COALESCE(
           (SELECT c.id FROM channels c WHERE c.id = g.system_channel_id AND c.guild_id = g.id AND c.type = 0),
           (SELECT c.id FROM channels c WHERE c.guild_id = g.id AND c.type = 0 ORDER BY c.position, c.id LIMIT 1),
           0)::bigint AS channel_id
FROM guilds g WHERE g.id = $1;

-- Trava o servidor (serializa entradas simultâneas para valer o limite de membros).
-- name: LockGuild :one
SELECT id FROM guilds WHERE id = $1 FOR NO KEY UPDATE;

-- name: IsGuildTextChannel :one
SELECT EXISTS (SELECT 1 FROM channels WHERE id = $1 AND guild_id = $2 AND type = 0);
