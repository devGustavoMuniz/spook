-- name: InsertDMChannel :one
INSERT INTO channels (id, type, owner_id, name) VALUES ($1, $2, $3, $4)
RETURNING *;

-- Reserva o par ordenado. 0 linhas = o par já tem DM (outra criação venceu).
-- name: InsertDMPair :execrows
INSERT INTO dm_pairs (user_a, user_b, channel_id) VALUES ($1, $2, $3)
ON CONFLICT (user_a, user_b) DO NOTHING;

-- name: GetDMPairChannel :one
SELECT c.* FROM dm_pairs p JOIN channels c ON c.id = p.channel_id
WHERE p.user_a = $1 AND p.user_b = $2;

-- name: InsertRecipient :execrows
INSERT INTO channel_recipients (channel_id, user_id) VALUES ($1, $2)
ON CONFLICT DO NOTHING;

-- name: DeleteRecipient :execrows
DELETE FROM channel_recipients WHERE channel_id = $1 AND user_id = $2;

-- name: CountRecipients :one
SELECT count(*) FROM channel_recipients WHERE channel_id = $1;

-- Serializa adições concorrentes ao mesmo grupo (limite de participantes).
-- name: LockChannel :one
SELECT id FROM channels WHERE id = $1 FOR NO KEY UPDATE;

-- name: IsRecipient :one
SELECT EXISTS (SELECT 1 FROM channel_recipients WHERE channel_id = $1 AND user_id = $2);

-- name: UpdateDMName :one
UPDATE channels SET name = $2 WHERE id = $1 AND type = 4
RETURNING *;

-- Quais dos candidatos compartilham pelo menos um servidor com o usuário.
-- name: ListUsersSharingGuild :many
SELECT DISTINCT o.user_id FROM guild_members me
JOIN guild_members o ON o.guild_id = me.guild_id
WHERE me.user_id = $1 AND o.user_id = ANY($2::bigint[]);

-- DMs do usuário, da atividade mais recente para a mais antiga (sem mensagens: pela criação).
-- name: ListDMChannelsByUser :many
SELECT c.* FROM channels c
JOIN channel_recipients r ON r.channel_id = c.id
WHERE r.user_id = $1
ORDER BY COALESCE(c.last_message_id, c.id) DESC;

-- name: ListRecipientsByChannels :many
SELECT r.channel_id, u.id AS user_id, u.username, u.display_name, u.avatar_key, user_plan(u.id) AS plan
FROM channel_recipients r JOIN users u ON u.id = r.user_id
WHERE r.channel_id = ANY($1::bigint[])
ORDER BY r.channel_id, r.user_id;
