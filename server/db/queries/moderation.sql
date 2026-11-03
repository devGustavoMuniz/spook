-- ---- banimentos ----

-- name: UpsertBan :exec
INSERT INTO guild_bans (guild_id, user_id, banned_by, reason) VALUES ($1, $2, $3, $4)
ON CONFLICT (guild_id, user_id) DO UPDATE SET banned_by = EXCLUDED.banned_by, reason = EXCLUDED.reason;

-- name: DeleteBan :execrows
DELETE FROM guild_bans WHERE guild_id = $1 AND user_id = $2;

-- name: IsBanned :one
SELECT EXISTS (SELECT 1 FROM guild_bans WHERE guild_id = $1 AND user_id = $2);

-- name: ListBans :many
SELECT b.guild_id, b.user_id, b.banned_by, b.reason, b.created_at,
       u.username, u.display_name, u.avatar_key,
       a.username AS banned_by_username
FROM guild_bans b
JOIN users u ON u.id = b.user_id
LEFT JOIN users a ON a.id = b.banned_by
WHERE b.guild_id = $1 AND b.user_id > $2
ORDER BY b.user_id
LIMIT $3;

-- name: GetBan :one
SELECT b.guild_id, b.user_id, b.banned_by, b.reason, b.created_at,
       u.username, u.display_name, u.avatar_key,
       a.username AS banned_by_username
FROM guild_bans b
JOIN users u ON u.id = b.user_id
LEFT JOIN users a ON a.id = b.banned_by
WHERE b.guild_id = $1 AND b.user_id = $2;

-- ---- apelido e mute de voz ----

-- name: SetMemberNickname :execrows
UPDATE guild_members SET nickname = $3 WHERE guild_id = $1 AND user_id = $2;

-- name: SetMemberVoiceMuted :execrows
UPDATE guild_members SET voice_muted = $3 WHERE guild_id = $1 AND user_id = $2;

-- name: GetMemberVoiceMuted :one
SELECT voice_muted FROM guild_members WHERE guild_id = $1 AND user_id = $2;

-- ---- overwrites de canal ----

-- name: ListChannelOverwrites :many
SELECT * FROM channel_overwrites WHERE channel_id = $1 ORDER BY target_type, target_id;

-- name: ListOverwritesByGuilds :many
SELECT o.* FROM channel_overwrites o JOIN channels c ON c.id = o.channel_id
WHERE c.guild_id = ANY($1::bigint[]);

-- name: UpsertChannelOverwrite :one
INSERT INTO channel_overwrites (channel_id, target_type, target_id, allow, deny) VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (channel_id, target_type, target_id) DO UPDATE SET allow = EXCLUDED.allow, deny = EXCLUDED.deny
RETURNING *;

-- name: DeleteChannelOverwrite :execrows
DELETE FROM channel_overwrites WHERE channel_id = $1 AND target_type = $2 AND target_id = $3;

-- Quem sai/é expulso/banido perde seus overwrites pessoais; um cargo excluído perde os dele.
-- name: DeleteMemberOverwrites :exec
DELETE FROM channel_overwrites o USING channels c
WHERE o.channel_id = c.id AND c.guild_id = $1 AND o.target_type = 'member' AND o.target_id = $2;

-- name: DeleteRoleOverwrites :exec
DELETE FROM channel_overwrites o USING channels c
WHERE o.channel_id = c.id AND c.guild_id = $1 AND o.target_type = 'role' AND o.target_id = $2;

-- name: UserExists :one
SELECT EXISTS (SELECT 1 FROM users WHERE id = $1 AND deleted_at IS NULL);
