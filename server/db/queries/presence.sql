-- Servidores do usuário (tópicos guild:<id> que veem a presença dele).
-- name: ListUserGuildIDs :many
SELECT guild_id FROM guild_members WHERE user_id = $1;

-- Quem divide uma DM (1:1 ou grupo) com o usuário (tópicos user:<id>).
-- name: ListDMPeerIDs :many
SELECT DISTINCT r2.user_id
FROM channel_recipients r1
JOIN channel_recipients r2 ON r2.channel_id = r1.channel_id AND r2.user_id <> r1.user_id
WHERE r1.user_id = $1
UNION
SELECT CASE WHEN user_a = $1 THEN user_b ELSE user_a END
FROM friendships WHERE status = 'accepted' AND (user_a = $1 OR user_b = $1);

-- Dos usuários online (memória), quem compartilha servidor ou DM com o usuário.
-- Parte dos servidores do usuário (poucos) e consulta o índice (guild_id, user_id) por usuário online:
-- nunca varre os membros de um servidor grande.
-- name: ListOnlineSharing :many
SELECT o.user_id FROM guild_members me
JOIN guild_members o ON o.guild_id = me.guild_id AND o.user_id = ANY($2::bigint[])
WHERE me.user_id = $1 AND o.user_id <> $1
UNION
SELECT r2.user_id FROM channel_recipients r1
JOIN channel_recipients r2 ON r2.channel_id = r1.channel_id AND r2.user_id = ANY($2::bigint[])
WHERE r1.user_id = $1 AND r2.user_id <> $1
UNION
SELECT CASE WHEN user_a = $1 THEN user_b ELSE user_a END FROM friendships
WHERE status = 'accepted'
  AND ((user_a = $1 AND user_b = ANY($2::bigint[])) OR (user_b = $1 AND user_a = ANY($2::bigint[])));

-- Dos usuários online, quem é membro do servidor.
-- name: ListOnlineGuildMembers :many
SELECT user_id FROM guild_members WHERE guild_id = $1 AND user_id = ANY($2::bigint[]);

-- Preferência de status e status personalizado (expiração avaliada pelo service).
-- name: GetStatusPrefs :one
SELECT status_pref, custom_status_text, custom_status_emoji, custom_status_expires_at FROM users WHERE id = $1;

-- name: SetStatusPrefs :execrows
UPDATE users
SET status_pref = $2, custom_status_text = $3, custom_status_emoji = $4, custom_status_expires_at = $5
WHERE id = $1;
