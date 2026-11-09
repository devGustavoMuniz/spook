-- Chamados de feedback, sugestões e bugs (feature feedback).

-- name: InsertTicket :one
INSERT INTO tickets (id, author_id, kind, title, context, message_count)
VALUES ($1, $2, $3, $4, sqlc.narg(context)::jsonb, 1)
RETURNING *;

-- name: InsertTicketMessage :one
INSERT INTO ticket_messages (id, ticket_id, author_id, kind, body)
VALUES ($1, $2, $3, $4, $5)
RETURNING *;

-- Chamados em andamento de um autor (limite de chamados abertos por pessoa).
-- name: CountActiveTicketsByAuthor :one
SELECT count(*)::bigint FROM tickets WHERE author_id = $1 AND status IN ('open', 'in_review', 'answered');

-- name: GetTicketForUpdate :one
SELECT * FROM tickets WHERE id = $1 FOR UPDATE;

-- name: GetTicket :one
SELECT * FROM tickets WHERE id = $1;

-- Conta as notas internas de um chamado (teto por chamado).
-- name: CountInternalTicketMessages :one
SELECT count(*)::bigint FROM ticket_messages WHERE ticket_id = $1 AND kind = 'internal';

-- Mensagens em ordem cronológica; include_internal=false esconde as notas dos admins (nunca vão ao autor).
-- name: ListTicketMessages :many
SELECT m.id, m.ticket_id, m.author_id, m.kind, m.body, m.created_at,
       COALESCE(u.username::text, '')::text AS author_username, u.display_name AS author_display_name
FROM ticket_messages m
LEFT JOIN users u ON u.id = m.author_id
WHERE m.ticket_id = $1 AND (sqlc.arg(include_internal)::boolean OR m.kind <> 'internal')
ORDER BY m.id;

-- Atualiza o chamado depois de uma mensagem pública ou de uma mudança de estado.
-- name: UpdateTicketActivity :one
UPDATE tickets SET
    status = sqlc.arg(status),
    user_unread = sqlc.arg(user_unread),
    message_count = message_count + sqlc.arg(added)::int,
    last_activity_at = now(), updated_at = now()
WHERE id = sqlc.arg(id)
RETURNING *;

-- name: MarkTicketRead :exec
UPDATE tickets SET user_unread = false WHERE id = $1 AND user_unread;

-- "Meus chamados": por atividade, cursor (last_activity_at, id) decrescente.
-- name: ListTicketsByAuthor :many
SELECT * FROM tickets
WHERE author_id = sqlc.arg(author_id)
  AND (sqlc.narg(status)::text IS NULL OR status = sqlc.narg(status)::text)
  AND (sqlc.narg(after_id)::bigint IS NULL
       OR (last_activity_at, id) < (sqlc.narg(after_at)::timestamptz, sqlc.narg(after_id)::bigint))
ORDER BY last_activity_at DESC, id DESC
LIMIT sqlc.arg(max_rows);

-- Fila do admin por atividade mais recente.
-- name: AdminListTicketsByActivity :many
SELECT t.*, u.username::text AS author_username, u.display_name AS author_display_name, u.email::text AS author_email
FROM tickets t JOIN users u ON u.id = t.author_id
WHERE (sqlc.narg(status)::text IS NULL OR t.status = sqlc.narg(status)::text)
  AND (sqlc.narg(kind)::text IS NULL OR t.kind = sqlc.narg(kind)::text)
  AND (sqlc.narg(q)::text IS NULL OR t.title ILIKE '%' || sqlc.narg(q)::text || '%' ESCAPE '\'
       OR u.username::text ILIKE '%' || sqlc.narg(q)::text || '%' ESCAPE '\')
  AND (sqlc.narg(after_id)::bigint IS NULL
       OR (t.last_activity_at, t.id) < (sqlc.narg(after_at)::timestamptz, sqlc.narg(after_id)::bigint))
ORDER BY t.last_activity_at DESC, t.id DESC
LIMIT sqlc.arg(max_rows);

-- Fila do admin do mais antigo para o mais novo (o ID Snowflake é cronológico).
-- name: AdminListTicketsOldest :many
SELECT t.*, u.username::text AS author_username, u.display_name AS author_display_name, u.email::text AS author_email
FROM tickets t JOIN users u ON u.id = t.author_id
WHERE (sqlc.narg(status)::text IS NULL OR t.status = sqlc.narg(status)::text)
  AND (sqlc.narg(kind)::text IS NULL OR t.kind = sqlc.narg(kind)::text)
  AND (sqlc.narg(q)::text IS NULL OR t.title ILIKE '%' || sqlc.narg(q)::text || '%' ESCAPE '\'
       OR u.username::text ILIKE '%' || sqlc.narg(q)::text || '%' ESCAPE '\')
  AND (sqlc.narg(after_id)::bigint IS NULL OR t.id > sqlc.narg(after_id)::bigint)
ORDER BY t.id
LIMIT sqlc.arg(max_rows);

-- name: AdminGetTicket :one
SELECT t.*, u.username::text AS author_username, u.display_name AS author_display_name, u.email::text AS author_email
FROM tickets t JOIN users u ON u.id = t.author_id
WHERE t.id = $1;

-- name: AdminTicketCounts :many
SELECT status, count(*)::bigint AS total FROM tickets GROUP BY status;

-- ---- anexos dos chamados ----

-- name: InsertTicketAttachment :exec
INSERT INTO ticket_attachments (id, ticket_id, uploader_id, object_key, filename, content_type, size_bytes)
VALUES ($1, $2, $3, $4, $5, $6, $7);

-- Anexos do usuário ainda sem mensagem, criados depois de $2 (limite de pendentes).
-- name: CountPendingTicketAttachments :one
SELECT count(*)::bigint FROM ticket_attachments
WHERE uploader_id = sqlc.arg(uploader_id) AND message_id IS NULL AND created_at > sqlc.arg(since);

-- Pendentes do usuário num chamado (ou rascunho); prova que o ID de rascunho é dele.
-- name: CountPendingTicketAttachmentsForTicket :one
SELECT count(*)::bigint FROM ticket_attachments
WHERE uploader_id = sqlc.arg(uploader_id) AND ticket_id = sqlc.arg(ticket_id) AND message_id IS NULL AND created_at > sqlc.arg(since);

-- Anexos já ligados a mensagens do chamado (teto por chamado).
-- name: CountTicketAttachments :one
SELECT count(*)::bigint FROM ticket_attachments WHERE ticket_id = $1 AND message_id IS NOT NULL;

-- name: ListPendingTicketAttachments :many
SELECT * FROM ticket_attachments
WHERE id = ANY(sqlc.arg(ids)::bigint[]) AND uploader_id = sqlc.arg(uploader_id) AND ticket_id = sqlc.arg(ticket_id)
  AND message_id IS NULL AND created_at > sqlc.arg(since)
ORDER BY id;

-- Liga os anexos à mensagem (na mesma transação que a insere); só vale para anexos livres, do usuário e do chamado.
-- name: ClaimTicketAttachments :many
UPDATE ticket_attachments SET message_id = sqlc.arg(message_id)
WHERE id = ANY(sqlc.arg(ids)::bigint[]) AND uploader_id = sqlc.arg(uploader_id) AND ticket_id = sqlc.arg(ticket_id)
  AND message_id IS NULL AND created_at > sqlc.arg(since)
RETURNING *;

-- Anexos de todas as mensagens do chamado; quem filtra as notas internas é o service (só lista mensagens visíveis).
-- name: ListTicketAttachments :many
SELECT * FROM ticket_attachments WHERE ticket_id = $1 AND message_id IS NOT NULL ORDER BY id;

-- name: ListOrphanTicketAttachments :many
SELECT * FROM ticket_attachments WHERE message_id IS NULL AND created_at < sqlc.arg(before) ORDER BY created_at LIMIT sqlc.arg(max_rows);

-- name: DeleteTicketAttachments :execrows
DELETE FROM ticket_attachments WHERE id = ANY(sqlc.arg(ids)::bigint[]) AND message_id IS NULL;
