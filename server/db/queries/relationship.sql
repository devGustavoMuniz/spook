-- Amizades e bloqueios (feature relationship). Os pares de friendships são ordenados (user_a < user_b).

-- name: FindUserByUsername :one
SELECT id FROM users WHERE username = $1 AND deleted_at IS NULL;

-- name: GetFriendship :one
SELECT user_a, user_b, status, requested_by, created_at, accepted_at
FROM friendships WHERE user_a = $1 AND user_b = $2;

-- name: LockFriendshipUsers :exec
-- Serializa as mudanças de relacionamento do par (e os limites) travando as duas linhas de usuário em ordem de ID.
SELECT id FROM users WHERE id = ANY($1::bigint[]) ORDER BY id FOR NO KEY UPDATE;

-- name: InsertFriendshipPending :execrows
INSERT INTO friendships (user_a, user_b, status, requested_by)
VALUES ($1, $2, 'pending', $3)
ON CONFLICT DO NOTHING;

-- name: AcceptFriendship :one
UPDATE friendships SET status = 'accepted', accepted_at = now()
WHERE user_a = $1 AND user_b = $2 AND status = 'pending' AND requested_by <> $3
RETURNING user_a, user_b, status, requested_by, created_at, accepted_at;

-- name: DeleteFriendship :one
DELETE FROM friendships WHERE user_a = $1 AND user_b = $2 RETURNING status, requested_by;

-- name: CountFriends :one
SELECT count(*) FROM friendships WHERE status = 'accepted' AND (user_a = $1 OR user_b = $1);

-- name: CountOutgoingRequests :one
SELECT count(*) FROM friendships WHERE status = 'pending' AND requested_by = $1;

-- name: InsertBlock :execrows
INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING;

-- name: DeleteBlock :execrows
DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2;

-- name: CountBlocks :one
SELECT count(*) FROM blocks WHERE blocker_id = $1;

-- name: GetBlock :one
SELECT created_at FROM blocks WHERE blocker_id = $1 AND blocked_id = $2;

-- Bloqueio em qualquer sentido entre o par.
-- name: BlockedEitherWay :one
SELECT EXISTS (SELECT 1 FROM blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1));

-- Entre os candidatos, quem tem bloqueio (qualquer sentido) com userID.
-- name: ListBlockedAmong :many
SELECT DISTINCT CASE WHEN blocker_id = $1 THEN blocked_id ELSE blocker_id END::bigint AS other_id
FROM blocks
WHERE (blocker_id = $1 AND blocked_id = ANY($2::bigint[])) OR (blocked_id = $1 AND blocker_id = ANY($2::bigint[]));

-- Entre os candidatos, quem BLOQUEOU userID (para não notificar quem bloqueou o autor).
-- name: ListBlockersAmong :many
SELECT blocker_id FROM blocks WHERE blocked_id = $1 AND blocker_id = ANY($2::bigint[]);

-- Entre os candidatos, quem é amigo aceito de userID.
-- name: ListFriendsAmong :many
SELECT CASE WHEN user_a = $1 THEN user_b ELSE user_a END::bigint AS friend_id
FROM friendships
WHERE status = 'accepted'
  AND ((user_a = $1 AND user_b = ANY($2::bigint[])) OR (user_b = $1 AND user_a = ANY($2::bigint[])));

-- Bloqueio entre os dois participantes de uma DM 1:1.
-- name: DMPairBlocked :one
SELECT EXISTS (
    SELECT 1 FROM dm_pairs p JOIN blocks b
      ON (b.blocker_id = p.user_a AND b.blocked_id = p.user_b) OR (b.blocker_id = p.user_b AND b.blocked_id = p.user_a)
    WHERE p.channel_id = $1);

-- Relacionamentos do usuário (amigos, pedidos e bloqueados), paginados por ID do outro usuário.
-- kind: friend, incoming, outgoing ou blocked; $3 vazio = todos.
-- name: ListRelationships :many
SELECT r.other_id, r.kind, r.since, u.username, u.display_name, u.avatar_key
FROM user_relationships r
JOIN users u ON u.id = r.other_id AND u.deleted_at IS NULL
WHERE r.user_id = $1 AND r.other_id > $2 AND ($3::text = '' OR r.kind = $3::text)
ORDER BY r.other_id
LIMIT $4;

-- Contagens por tipo (READY e badge).
-- name: CountRelationshipKinds :many
SELECT r.kind, count(*)::bigint AS n
FROM user_relationships r JOIN users u ON u.id = r.other_id AND u.deleted_at IS NULL
WHERE r.user_id = $1 GROUP BY r.kind;

-- Amigos e pedidos para o READY (os bloqueados vão só como IDs): pedidos recebidos, enviados e depois amigos.
-- name: ListRelationshipsReady :many
SELECT r.other_id, r.kind, r.since, u.username, u.display_name, u.avatar_key
FROM user_relationships r
JOIN users u ON u.id = r.other_id AND u.deleted_at IS NULL
WHERE r.user_id = $1 AND r.kind <> 'blocked'
ORDER BY CASE r.kind WHEN 'incoming' THEN 0 WHEN 'outgoing' THEN 1 ELSE 2 END, r.other_id
LIMIT $2;

-- name: ListBlockedIDs :many
SELECT b.blocked_id FROM blocks b WHERE b.blocker_id = $1 ORDER BY b.blocked_id;

-- Um relacionamento específico.
-- name: GetRelationship :one
SELECT kind, since FROM user_relationships WHERE user_id = $1 AND other_id = $2 ORDER BY (kind = 'blocked') DESC LIMIT 1;

-- Perfil mínimo de um usuário para montar o payload de relacionamento.
-- name: GetUserBrief :one
SELECT id, username, display_name, avatar_key FROM users WHERE id = $1 AND deleted_at IS NULL;

-- Quem os amigos aceitos de userID são (para a presença).
-- name: ListFriendIDs :many
SELECT CASE WHEN user_a = $1 THEN user_b ELSE user_a END::bigint AS friend_id
FROM friendships WHERE status = 'accepted' AND (user_a = $1 OR user_b = $1);

-- Se os dois compartilham pelo menos um servidor.
-- name: SharesGuild :one
SELECT EXISTS (SELECT 1 FROM guild_members a JOIN guild_members b ON b.guild_id = a.guild_id WHERE a.user_id = $1 AND b.user_id = $2);

-- Exclusão de conta: remove amizades e bloqueios nos dois sentidos.
-- name: DeleteFriendshipsByUser :exec
DELETE FROM friendships WHERE user_a = $1 OR user_b = $1;

-- name: DeleteBlocksByUser :exec
DELETE FROM blocks WHERE blocker_id = $1 OR blocked_id = $1;
