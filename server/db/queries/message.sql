-- Insere a mensagem e avança channels.last_message_id numa só ida ao banco.
-- name: InsertMessage :one
WITH m AS (
    INSERT INTO messages (id, channel_id, author_id, content, mention_ids, reference_id, kind, mention_everyone, mention_here, mention_role_ids)
    VALUES ($1, $2, $3, $4, sqlc.arg(mention_ids)::bigint[], sqlc.narg(reference_id), sqlc.arg(kind)::text,
            sqlc.arg(mention_everyone)::boolean, sqlc.arg(mention_here)::boolean, sqlc.arg(mention_role_ids)::bigint[])
    RETURNING id, channel_id, author_id, content, edited_at, mention_ids, reference_id, pinned_at, kind, mention_everyone, mention_here, mention_role_ids
), c AS (
    UPDATE channels SET last_message_id = $1 WHERE id = $2 AND (last_message_id IS NULL OR last_message_id < $1)
)
SELECT m.id, m.channel_id, m.author_id, m.content, m.edited_at, m.mention_ids, m.reference_id, m.pinned_at, m.kind, m.mention_everyone, m.mention_here, m.mention_role_ids,
       u.username, u.display_name, u.avatar_key
FROM m JOIN users u ON u.id = m.author_id;

-- name: GetMessage :one
SELECT m.id, m.channel_id, m.author_id, m.content, m.edited_at, m.mention_ids, m.reference_id, m.pinned_at, m.kind, m.mention_everyone, m.mention_here, m.mention_role_ids,
       u.username, u.display_name, u.avatar_key
FROM messages m JOIN users u ON u.id = m.author_id
WHERE m.id = $1 AND m.channel_id = $2 AND m.deleted_at IS NULL;

-- name: ListMessages :many
SELECT m.id, m.channel_id, m.author_id, m.content, m.edited_at, m.mention_ids, m.reference_id, m.pinned_at, m.kind, m.mention_everyone, m.mention_here, m.mention_role_ids,
       u.username, u.display_name, u.avatar_key
FROM messages m JOIN users u ON u.id = m.author_id
WHERE m.channel_id = $1 AND m.id < $2 AND m.deleted_at IS NULL
ORDER BY m.id DESC
LIMIT $3;

-- Mensagens respondidas de um lote (inclui as apagadas, para o cliente mostrar "mensagem apagada"),
-- limitadas ao canal. Uma consulta para a página inteira.
-- name: GetReferencedMessages :many
SELECT m.id, m.author_id, m.content, m.kind, (m.deleted_at IS NOT NULL)::boolean AS deleted,
       EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id) AS has_attachments,
       u.username, u.display_name
FROM messages m JOIN users u ON u.id = m.author_id
WHERE m.id = ANY(sqlc.arg(ids)::bigint[]) AND m.channel_id = $1;

-- name: ListPinnedMessages :many
SELECT m.id, m.channel_id, m.author_id, m.content, m.edited_at, m.mention_ids, m.reference_id, m.pinned_at, m.kind, m.mention_everyone, m.mention_here, m.mention_role_ids,
       u.username, u.display_name, u.avatar_key
FROM messages m JOIN users u ON u.id = m.author_id
WHERE m.channel_id = $1 AND m.pinned_at IS NOT NULL AND m.deleted_at IS NULL
ORDER BY m.pinned_at DESC, m.id DESC
LIMIT $2;

-- Fixa só se ainda não está fixada e o canal tem menos de max_pins fixadas (checagem e escrita juntas).
-- name: PinMessage :execrows
UPDATE messages SET pinned_at = now(), pinned_by = $3
WHERE messages.id = $1 AND messages.channel_id = $2 AND messages.deleted_at IS NULL AND messages.pinned_at IS NULL
  AND (SELECT count(*) FROM messages p WHERE p.channel_id = $2 AND p.pinned_at IS NOT NULL AND p.deleted_at IS NULL) < sqlc.arg(max_pins)::int;

-- name: UnpinMessage :execrows
UPDATE messages SET pinned_at = NULL, pinned_by = NULL
WHERE id = $1 AND channel_id = $2 AND deleted_at IS NULL AND pinned_at IS NOT NULL;

-- name: UpdateMessageContent :execrows
UPDATE messages SET content = $3, edited_at = now()
WHERE id = $1 AND channel_id = $2 AND deleted_at IS NULL;

-- Apagar também desafixa (a mensagem some das fixadas e não conta no limite).
-- name: SoftDeleteMessage :execrows
UPDATE messages SET deleted_at = now(), pinned_at = NULL, pinned_by = NULL
WHERE id = $1 AND channel_id = $2 AND deleted_at IS NULL;

-- Reentrada logo depois de sair não repete a mensagem de entrada: procura uma do mesmo autor no último minuto.
-- name: HasRecentJoinMessage :one
SELECT EXISTS (
    SELECT 1 FROM messages
    WHERE channel_id = $1 AND author_id = $2 AND kind = 'member_join' AND deleted_at IS NULL
      AND id > snowflake_floor(now() - interval '1 minute'));
