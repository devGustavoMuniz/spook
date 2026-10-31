-- Estado de leitura, menções e inscrições de Web Push (Fase 6b).

-- Marca o canal como lido até $3 (nunca regride, nunca passa da última mensagem do canal) e zera as menções
-- quando o ack alcança a última mensagem. Sem linha, a base é a entrada no servidor (DM: a criação do canal).
-- name: AckChannel :one
INSERT INTO read_states (user_id, channel_id, last_read_message_id, mention_count)
SELECT sqlc.arg(user_id)::bigint, c.id,
       GREATEST(
           LEAST(sqlc.arg(message_id)::bigint, COALESCE(c.last_message_id, 0)),
           CASE WHEN c.guild_id IS NULL THEN c.id
                ELSE COALESCE((SELECT snowflake_floor(gm.joined_at) FROM guild_members gm
                               WHERE gm.guild_id = c.guild_id AND gm.user_id = sqlc.arg(user_id)::bigint), 0) END),
       0
FROM channels c
WHERE c.id = sqlc.arg(channel_id)::bigint
ON CONFLICT (user_id, channel_id) DO UPDATE SET
    last_read_message_id = GREATEST(read_states.last_read_message_id, EXCLUDED.last_read_message_id),
    mention_count = CASE
        WHEN GREATEST(read_states.last_read_message_id, EXCLUDED.last_read_message_id)
             >= (SELECT COALESCE(ch.last_message_id, 0) FROM channels ch WHERE ch.id = EXCLUDED.channel_id)
        THEN 0 ELSE read_states.mention_count END
RETURNING last_read_message_id, mention_count;

-- Quem sai (ou é expulso) do servidor perde o estado de leitura dele: ao voltar, a base é a nova entrada.
-- name: DeleteGuildReadStates :exec
DELETE FROM read_states rs USING channels c
WHERE rs.channel_id = c.id AND c.guild_id = sqlc.arg(guild_id)::bigint AND rs.user_id = sqlc.arg(user_id)::bigint;

-- Soma uma menção a cada usuário, criando o estado (com a base de entrada) se ainda não existir.
-- name: IncrementMentions :many
INSERT INTO read_states (user_id, channel_id, last_read_message_id, mention_count)
SELECT u.id, sqlc.arg(channel_id)::bigint,
       CASE WHEN sqlc.narg('guild_id')::bigint IS NULL THEN sqlc.arg(channel_id)::bigint
            ELSE COALESCE((SELECT snowflake_floor(gm.joined_at) FROM guild_members gm
                           WHERE gm.guild_id = sqlc.narg('guild_id')::bigint AND gm.user_id = u.id), 0) END,
       1
FROM unnest(sqlc.arg(user_ids)::bigint[]) AS u(id)
ON CONFLICT (user_id, channel_id) DO UPDATE SET mention_count = read_states.mention_count + 1
RETURNING user_id, last_read_message_id, mention_count;

-- Um canal por linha: textos dos servidores em $2 (VIEW_CHANNEL, decidido pelo chamador) e as DMs do usuário.
-- O canal só paga a contagem quando last_message_id > last_read, e a contagem para em 100 (LIMIT sobre
-- o índice (channel_id, id DESC)). Mensagens do próprio usuário e apagadas não contam.
-- name: ListReadStates :many
WITH accessible AS (
    SELECT c.id AS channel_id, c.guild_id, c.last_message_id,
           COALESCE(rs.last_read_message_id, snowflake_floor(gm.joined_at))::bigint AS last_read,
           COALESCE(rs.mention_count, 0)::int AS mention_count
    FROM channels c
    JOIN guild_members gm ON gm.guild_id = c.guild_id AND gm.user_id = sqlc.arg(user_id)::bigint
    LEFT JOIN read_states rs ON rs.channel_id = c.id AND rs.user_id = sqlc.arg(user_id)::bigint
    WHERE c.type = 0 AND c.guild_id = ANY(sqlc.arg(guild_ids)::bigint[])
    UNION ALL
    SELECT c.id, c.guild_id, c.last_message_id,
           COALESCE(rs.last_read_message_id, c.id)::bigint,
           COALESCE(rs.mention_count, 0)::int
    FROM channel_recipients cr
    JOIN channels c ON c.id = cr.channel_id
    LEFT JOIN read_states rs ON rs.channel_id = c.id AND rs.user_id = sqlc.arg(user_id)::bigint
    WHERE cr.user_id = sqlc.arg(user_id)::bigint
)
SELECT a.channel_id, a.guild_id, a.last_read::bigint AS last_read_message_id, a.mention_count,
       (CASE WHEN a.last_message_id > a.last_read THEN
            (SELECT count(*) FROM (
                SELECT 1 FROM messages m
                WHERE m.channel_id = a.channel_id AND m.id > a.last_read AND m.author_id <> sqlc.arg(user_id)::bigint AND m.deleted_at IS NULL
                ORDER BY m.id DESC LIMIT 100) q)
        ELSE 0 END)::int AS unread_count
FROM accessible a
ORDER BY a.channel_id;

-- Candidatos a menção num servidor: membros pelo username, com o necessário para decidir VIEW_CHANNEL.
-- name: ResolveGuildMentions :many
SELECT u.id AS user_id, g.owner_id,
       COALESCE(bit_or(r.permissions), 0)::bigint AS permissions
FROM users u
JOIN guild_members m ON m.user_id = u.id AND m.guild_id = sqlc.arg(guild_id)::bigint
JOIN guilds g ON g.id = m.guild_id
LEFT JOIN roles r ON r.guild_id = g.id
     AND (r.id = g.id OR r.id IN (SELECT mr.role_id FROM member_roles mr WHERE mr.guild_id = g.id AND mr.user_id = u.id))
WHERE u.username = ANY(sqlc.arg(usernames)::text[]::citext[]) AND u.id <> sqlc.arg(author_id)::bigint
GROUP BY u.id, g.owner_id;

-- Candidatos a menção numa DM: os participantes (menos o autor) pelo username.
-- name: ResolveDMMentions :many
SELECT u.id FROM users u
JOIN channel_recipients cr ON cr.user_id = u.id AND cr.channel_id = sqlc.arg(channel_id)::bigint
WHERE u.username = ANY(sqlc.arg(usernames)::text[]::citext[]) AND u.id <> sqlc.arg(author_id)::bigint;

-- name: ListChannelRecipientIDs :many
SELECT user_id FROM channel_recipients WHERE channel_id = $1;

-- Dados para montar o push na hora do envio (a mensagem apagada nesse meio tempo some da consulta).
-- name: GetPushContext :one
SELECT m.content, u.username, u.display_name, c.name AS channel_name, c.guild_id, g.name AS guild_name,
       (SELECT count(*) FROM attachments a WHERE a.message_id = m.id)::int AS attachment_count
FROM messages m
JOIN users u ON u.id = m.author_id
JOIN channels c ON c.id = m.channel_id
LEFT JOIN guilds g ON g.id = c.guild_id
WHERE m.id = $1 AND m.deleted_at IS NULL;

-- name: UpsertPushSubscription :one
INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth
RETURNING *;

-- Inscrições do usuário, sem contar a do endpoint que está sendo (re)inscrito.
-- name: CountPushSubscriptionsExcept :one
SELECT count(*) FROM push_subscriptions WHERE user_id = $1 AND endpoint <> $2;

-- name: DeletePushSubscription :execrows
DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2;

-- name: DeletePushSubscriptionByID :exec
DELETE FROM push_subscriptions WHERE id = $1;

-- name: GetPushSubscription :one
SELECT * FROM push_subscriptions WHERE id = $1;

-- name: ListPushSubscriptionsByUsers :many
SELECT * FROM push_subscriptions WHERE user_id = ANY($1::bigint[]) ORDER BY id;
