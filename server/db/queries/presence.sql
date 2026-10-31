-- Servidores do usuário (tópicos guild:<id> que veem a presença dele).
-- name: ListUserGuildIDs :many
SELECT guild_id FROM guild_members WHERE user_id = $1;

-- Quem divide uma DM (1:1 ou grupo) com o usuário (tópicos user:<id>).
-- name: ListDMPeerIDs :many
SELECT DISTINCT r2.user_id
FROM channel_recipients r1
JOIN channel_recipients r2 ON r2.channel_id = r1.channel_id AND r2.user_id <> r1.user_id
WHERE r1.user_id = $1;

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
WHERE r1.user_id = $1 AND r2.user_id <> $1;

-- Dos usuários online, quem é membro do servidor.
-- name: ListOnlineGuildMembers :many
SELECT user_id FROM guild_members WHERE guild_id = $1 AND user_id = ANY($2::bigint[]);
