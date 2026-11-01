-- Consultas do painel administrativo (/admin). Agregados caros: o service as guarda em cache.

-- name: AdminIsAdmin :one
SELECT is_admin FROM users WHERE id = $1;

-- Promove os usernames informados (idempotente); devolve só quem mudou. Nunca rebaixa ninguém.
-- name: AdminPromoteUsernames :many
UPDATE users SET is_admin = true
WHERE username = ANY(sqlc.arg(usernames)::text[]::citext[]) AND NOT is_admin
RETURNING username::text AS username;

-- Liga ou desliga o administrador de um username (usado pelo comando `spook admin`); sem linha = conta inexistente.
-- name: AdminSetAdmin :one
UPDATE users SET is_admin = sqlc.arg(is_admin)::boolean
WHERE username = sqlc.arg(username)::text::citext
RETURNING username::text AS username;

-- name: AdminListAdmins :many
SELECT username::text AS username FROM users WHERE is_admin ORDER BY username;

-- Contagens do painel. Períodos usam o ID Snowflake (chave primária) em vez de uma coluna de data.
-- name: AdminCounts :one
SELECT
    (SELECT count(*) FROM users)::bigint AS users_total,
    (SELECT count(*) FROM users WHERE is_admin)::bigint AS admins,
    (SELECT count(*) FROM users WHERE created_at >= sqlc.arg(since_24h)::timestamptz)::bigint AS users_new_24h,
    (SELECT count(*) FROM users WHERE created_at >= sqlc.arg(since_7d)::timestamptz)::bigint AS users_new_7d,
    (SELECT count(*) FROM users WHERE avatar_key IS NOT NULL)::bigint AS avatars,
    (SELECT count(*) FROM guilds)::bigint AS guilds_total,
    (SELECT count(*) FROM guilds WHERE icon_key IS NOT NULL)::bigint AS guild_icons,
    (SELECT count(*) FROM guild_members)::bigint AS memberships,
    (SELECT count(*) FROM channels WHERE type = 0)::bigint AS text_channels,
    (SELECT count(*) FROM channels WHERE type = 1)::bigint AS voice_channels,
    (SELECT count(*) FROM channels WHERE type = 2)::bigint AS categories,
    (SELECT count(*) FROM channels WHERE type = 3)::bigint AS direct_chats,
    (SELECT count(*) FROM channels WHERE type = 4)::bigint AS group_chats,
    (SELECT count(*) FROM roles)::bigint AS roles,
    (SELECT count(*) FROM invites WHERE (expires_at IS NULL OR expires_at > now())
        AND (max_uses IS NULL OR uses < max_uses))::bigint AS invites_active,
    (SELECT COALESCE(sum(uses), 0) FROM invites)::bigint AS invite_uses,
    (SELECT count(*) FROM messages WHERE id >= sqlc.arg(min_id_24h)::bigint AND deleted_at IS NULL)::bigint AS messages_24h,
    (SELECT count(*) FROM messages WHERE id >= sqlc.arg(min_id_7d)::bigint AND deleted_at IS NULL)::bigint AS messages_7d,
    (SELECT count(*) FROM attachments)::bigint AS attachments,
    (SELECT COALESCE(sum(size_bytes), 0) FROM attachments)::bigint AS attachment_bytes;

-- Total de mensagens e a divisão servidores x DMs (varredura: o service cacheia).
-- name: AdminMessageTotals :one
SELECT
    count(*)::bigint AS total,
    (count(*) FILTER (WHERE c.guild_id IS NOT NULL))::bigint AS in_guilds,
    (count(*) FILTER (WHERE c.guild_id IS NULL))::bigint AS in_dms
FROM messages m JOIN channels c ON c.id = m.channel_id
WHERE m.deleted_at IS NULL;

-- Novas contas por dia (UTC) desde $1.
-- name: AdminUsersPerDay :many
SELECT (date_trunc('day', created_at AT TIME ZONE 'UTC'))::date AS day, count(*)::bigint AS n
FROM users WHERE created_at >= sqlc.arg(since)::timestamptz
GROUP BY 1 ORDER BY 1;

-- Mensagens por dia (UTC) desde o ID mínimo; a data vem do Snowflake (epoch 2026-01-01Z = 1767225600000 ms).
-- name: AdminMessagesPerDay :many
SELECT (date_trunc('day', to_timestamp(((id >> 22) + 1767225600000) / 1000.0) AT TIME ZONE 'UTC'))::date AS day,
       count(*)::bigint AS n
FROM messages WHERE id >= sqlc.arg(min_id)::bigint AND deleted_at IS NULL
GROUP BY 1 ORDER BY 1;

-- name: AdminDatabaseSize :one
SELECT pg_database_size(current_database())::bigint AS bytes;

-- name: AdminLargestTables :many
SELECT c.relname::text AS name, pg_total_relation_size(c.oid)::bigint AS bytes, GREATEST(c.reltuples, 0)::bigint AS rows_estimate
FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
ORDER BY pg_total_relation_size(c.oid) DESC
LIMIT 6;

-- Usuários: busca por username/e-mail (sem LIKE: sem curingas para escapar) e ordenação por coluna.
-- name: AdminListUsers :many
SELECT t.*, (count(*) OVER ())::bigint AS total FROM (
    SELECT u.id, u.username::text AS username, u.email::text AS email, u.created_at,
           (SELECT count(*) FROM guild_members gm WHERE gm.user_id = u.id)::bigint AS guilds_member,
           (SELECT count(*) FROM guilds g WHERE g.owner_id = u.id)::bigint AS guilds_owned,
           (SELECT count(*) FROM messages m WHERE m.author_id = u.id AND m.deleted_at IS NULL)::bigint AS messages_sent,
           (SELECT max(s.created_at) FROM sessions s WHERE s.user_id = u.id)::timestamptz AS last_active_at
    FROM users u
    WHERE sqlc.arg(q)::text = ''
       OR strpos(lower(u.username::text), lower(sqlc.arg(q)::text)) > 0
       OR strpos(lower(u.email::text), lower(sqlc.arg(q)::text)) > 0
) t
ORDER BY
    CASE WHEN sqlc.arg(sort)::text = 'username' AND sqlc.arg(dir)::text = 'asc' THEN t.username END ASC,
    CASE WHEN sqlc.arg(sort)::text = 'username' AND sqlc.arg(dir)::text = 'desc' THEN t.username END DESC,
    CASE WHEN sqlc.arg(sort)::text = 'email' AND sqlc.arg(dir)::text = 'asc' THEN t.email END ASC,
    CASE WHEN sqlc.arg(sort)::text = 'email' AND sqlc.arg(dir)::text = 'desc' THEN t.email END DESC,
    CASE WHEN sqlc.arg(sort)::text = 'guilds_member' AND sqlc.arg(dir)::text = 'asc' THEN t.guilds_member END ASC,
    CASE WHEN sqlc.arg(sort)::text = 'guilds_member' AND sqlc.arg(dir)::text = 'desc' THEN t.guilds_member END DESC,
    CASE WHEN sqlc.arg(sort)::text = 'guilds_owned' AND sqlc.arg(dir)::text = 'asc' THEN t.guilds_owned END ASC,
    CASE WHEN sqlc.arg(sort)::text = 'guilds_owned' AND sqlc.arg(dir)::text = 'desc' THEN t.guilds_owned END DESC,
    CASE WHEN sqlc.arg(sort)::text = 'messages_sent' AND sqlc.arg(dir)::text = 'asc' THEN t.messages_sent END ASC,
    CASE WHEN sqlc.arg(sort)::text = 'messages_sent' AND sqlc.arg(dir)::text = 'desc' THEN t.messages_sent END DESC,
    CASE WHEN sqlc.arg(sort)::text = 'last_active_at' AND sqlc.arg(dir)::text = 'asc' THEN t.last_active_at END ASC NULLS LAST,
    CASE WHEN sqlc.arg(sort)::text = 'last_active_at' AND sqlc.arg(dir)::text = 'desc' THEN t.last_active_at END DESC NULLS LAST,
    CASE WHEN sqlc.arg(sort)::text = 'created_at' AND sqlc.arg(dir)::text = 'asc' THEN t.created_at END ASC,
    CASE WHEN sqlc.arg(sort)::text = 'created_at' AND sqlc.arg(dir)::text = 'desc' THEN t.created_at END DESC,
    t.id ASC
LIMIT sqlc.arg(page_size)::int OFFSET sqlc.arg(page_offset)::int;

-- name: AdminListGuilds :many
SELECT t.*, (count(*) OVER ())::bigint AS total FROM (
    SELECT g.id, g.name, o.username::text AS owner, g.created_at,
           (SELECT count(*) FROM guild_members gm WHERE gm.guild_id = g.id)::bigint AS members,
           (SELECT count(*) FROM channels c WHERE c.guild_id = g.id AND c.type <> 2)::bigint AS channels,
           (SELECT count(*) FROM messages m JOIN channels c ON c.id = m.channel_id
             WHERE c.guild_id = g.id AND m.deleted_at IS NULL)::bigint AS messages,
           (SELECT count(*) FROM invites i WHERE i.guild_id = g.id AND (i.expires_at IS NULL OR i.expires_at > now())
             AND (i.max_uses IS NULL OR i.uses < i.max_uses))::bigint AS invites_active
    FROM guilds g JOIN users o ON o.id = g.owner_id
    WHERE sqlc.arg(q)::text = ''
       OR strpos(lower(g.name), lower(sqlc.arg(q)::text)) > 0
       OR strpos(lower(o.username::text), lower(sqlc.arg(q)::text)) > 0
) t
ORDER BY
    CASE WHEN sqlc.arg(sort)::text = 'name' AND sqlc.arg(dir)::text = 'asc' THEN lower(t.name) END ASC,
    CASE WHEN sqlc.arg(sort)::text = 'name' AND sqlc.arg(dir)::text = 'desc' THEN lower(t.name) END DESC,
    CASE WHEN sqlc.arg(sort)::text = 'owner' AND sqlc.arg(dir)::text = 'asc' THEN t.owner END ASC,
    CASE WHEN sqlc.arg(sort)::text = 'owner' AND sqlc.arg(dir)::text = 'desc' THEN t.owner END DESC,
    CASE WHEN sqlc.arg(sort)::text = 'members' AND sqlc.arg(dir)::text = 'asc' THEN t.members END ASC,
    CASE WHEN sqlc.arg(sort)::text = 'members' AND sqlc.arg(dir)::text = 'desc' THEN t.members END DESC,
    CASE WHEN sqlc.arg(sort)::text = 'channels' AND sqlc.arg(dir)::text = 'asc' THEN t.channels END ASC,
    CASE WHEN sqlc.arg(sort)::text = 'channels' AND sqlc.arg(dir)::text = 'desc' THEN t.channels END DESC,
    CASE WHEN sqlc.arg(sort)::text = 'messages' AND sqlc.arg(dir)::text = 'asc' THEN t.messages END ASC,
    CASE WHEN sqlc.arg(sort)::text = 'messages' AND sqlc.arg(dir)::text = 'desc' THEN t.messages END DESC,
    CASE WHEN sqlc.arg(sort)::text = 'invites_active' AND sqlc.arg(dir)::text = 'asc' THEN t.invites_active END ASC,
    CASE WHEN sqlc.arg(sort)::text = 'invites_active' AND sqlc.arg(dir)::text = 'desc' THEN t.invites_active END DESC,
    CASE WHEN sqlc.arg(sort)::text = 'created_at' AND sqlc.arg(dir)::text = 'asc' THEN t.created_at END ASC,
    CASE WHEN sqlc.arg(sort)::text = 'created_at' AND sqlc.arg(dir)::text = 'desc' THEN t.created_at END DESC,
    t.id ASC
LIMIT sqlc.arg(page_size)::int OFFSET sqlc.arg(page_offset)::int;

-- Canais (com o servidor) e usuários citados por salas de voz ativas.
-- name: AdminChannelInfo :many
SELECT c.id, c.name, c.type, c.guild_id, g.name AS guild_name
FROM channels c LEFT JOIN guilds g ON g.id = c.guild_id
WHERE c.id = ANY(sqlc.arg(ids)::bigint[]);

-- name: AdminUsernames :many
SELECT id, username::text AS username, display_name FROM users WHERE id = ANY(sqlc.arg(ids)::bigint[]);
