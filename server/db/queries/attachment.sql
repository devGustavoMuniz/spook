-- name: InsertAttachment :exec
INSERT INTO attachments (id, uploader_id, object_key, filename, content_type, size_bytes)
VALUES ($1, $2, $3, $4, $5, $6);

-- Anexos ainda sem mensagem criados depois de $2 (janela de 1 h).
-- name: CountPendingAttachments :one
SELECT count(*) FROM attachments
WHERE uploader_id = sqlc.arg(uploader_id) AND message_id IS NULL AND created_at > sqlc.arg(since);

-- Anexos que o usuário pode associar a uma mensagem do canal (o prefixo da chave identifica o canal).
-- name: ListPendingAttachments :many
SELECT id, message_id, uploader_id, object_key, filename, content_type, size_bytes, width, height, thumbnail_key, created_at
FROM attachments
WHERE id = ANY(sqlc.arg(ids)::bigint[]) AND uploader_id = sqlc.arg(uploader_id) AND message_id IS NULL
  AND created_at > sqlc.arg(since) AND starts_with(object_key, sqlc.arg(key_prefix)::text)
ORDER BY id;

-- Associa os anexos à mensagem (na mesma transação que a insere); só vale para anexos ainda livres.
-- name: ClaimAttachments :many
UPDATE attachments SET message_id = sqlc.arg(message_id)
WHERE id = ANY(sqlc.arg(ids)::bigint[]) AND uploader_id = sqlc.arg(uploader_id) AND message_id IS NULL
  AND created_at > sqlc.arg(since) AND starts_with(object_key, sqlc.arg(key_prefix)::text)
RETURNING id, message_id, uploader_id, object_key, filename, content_type, size_bytes, width, height, thumbnail_key, created_at;

-- name: ListAttachmentsByMessages :many
SELECT id, message_id, uploader_id, object_key, filename, content_type, size_bytes, width, height, thumbnail_key, created_at
FROM attachments
WHERE message_id = ANY(sqlc.arg(message_ids)::bigint[])
ORDER BY id;

-- name: GetAttachmentForThumbnail :one
SELECT a.id, a.message_id, a.uploader_id, a.object_key, a.filename, a.content_type, a.size_bytes,
       a.width, a.height, a.thumbnail_key, a.created_at, m.channel_id
FROM attachments a JOIN messages m ON m.id = a.message_id
WHERE a.id = $1;

-- name: SetAttachmentThumbnail :execrows
UPDATE attachments SET width = $2, height = $3, thumbnail_key = $4 WHERE id = $1;

-- name: ListOrphanAttachments :many
SELECT id, message_id, uploader_id, object_key, filename, content_type, size_bytes, width, height, thumbnail_key, created_at
FROM attachments
WHERE message_id IS NULL AND created_at < sqlc.arg(before)
ORDER BY created_at
LIMIT sqlc.arg(max_rows);

-- name: DeleteAttachments :execrows
DELETE FROM attachments WHERE id = ANY(sqlc.arg(ids)::bigint[]) AND message_id IS NULL;
