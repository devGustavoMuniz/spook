-- name: InsertInvite :one
INSERT INTO invites (code, guild_id, creator_id, max_uses, expires_at)
VALUES ($1, $2, $3, $4, $5)
RETURNING *;

-- name: GetInvite :one
SELECT * FROM invites WHERE code = $1;

-- name: ListInvitesByGuild :many
SELECT * FROM invites WHERE guild_id = $1 ORDER BY created_at DESC, code;

-- name: DeleteInvite :execrows
DELETE FROM invites WHERE code = $1;

-- Consome um uso de forma atômica: só atualiza se o convite ainda é válido.
-- name: UseInvite :execrows
UPDATE invites SET uses = uses + 1
WHERE code = $1
  AND (expires_at IS NULL OR expires_at > now())
  AND (max_uses IS NULL OR uses < max_uses);

-- name: GetInvitePreview :one
SELECT i.code, i.guild_id, i.max_uses, i.uses, i.expires_at,
       g.name AS guild_name, g.icon_key AS guild_icon_key,
       (SELECT count(*) FROM guild_members m WHERE m.guild_id = i.guild_id) AS member_count
FROM invites i JOIN guilds g ON g.id = i.guild_id
WHERE i.code = $1;

-- Convites ainda válidos do servidor (os expirados ou esgotados não contam para o limite).
-- name: CountInvitesByGuild :one
SELECT count(*) FROM invites
WHERE guild_id = $1 AND (expires_at IS NULL OR expires_at > now()) AND (max_uses IS NULL OR uses < max_uses);
