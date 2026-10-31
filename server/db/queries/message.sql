-- Insere a mensagem e avança channels.last_message_id numa só ida ao banco.
-- name: InsertMessage :one
WITH m AS (
    INSERT INTO messages (id, channel_id, author_id, content) VALUES ($1, $2, $3, $4)
    RETURNING id, channel_id, author_id, content, edited_at
), c AS (
    UPDATE channels SET last_message_id = $1 WHERE id = $2 AND (last_message_id IS NULL OR last_message_id < $1)
)
SELECT m.id, m.channel_id, m.author_id, m.content, m.edited_at,
       u.username, u.display_name, u.avatar_key
FROM m JOIN users u ON u.id = m.author_id;

-- name: GetMessage :one
SELECT m.id, m.channel_id, m.author_id, m.content, m.edited_at,
       u.username, u.display_name, u.avatar_key
FROM messages m JOIN users u ON u.id = m.author_id
WHERE m.id = $1 AND m.channel_id = $2 AND m.deleted_at IS NULL;

-- name: ListMessages :many
SELECT m.id, m.channel_id, m.author_id, m.content, m.edited_at,
       u.username, u.display_name, u.avatar_key
FROM messages m JOIN users u ON u.id = m.author_id
WHERE m.channel_id = $1 AND m.id < $2 AND m.deleted_at IS NULL
ORDER BY m.id DESC
LIMIT $3;

-- name: UpdateMessageContent :execrows
UPDATE messages SET content = $3, edited_at = now()
WHERE id = $1 AND channel_id = $2 AND deleted_at IS NULL;

-- name: SoftDeleteMessage :execrows
UPDATE messages SET deleted_at = now()
WHERE id = $1 AND channel_id = $2 AND deleted_at IS NULL;
