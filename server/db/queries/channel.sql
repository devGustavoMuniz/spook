-- name: InsertChannel :one
INSERT INTO channels (id, type, guild_id, parent_id, name, position)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING *;

-- name: GetChannel :one
SELECT * FROM channels WHERE id = $1;

-- name: ListChannelsByGuild :many
SELECT * FROM channels WHERE guild_id = $1 ORDER BY position, id;

-- name: ListChannelsByGuilds :many
SELECT * FROM channels WHERE guild_id = ANY($1::bigint[]) ORDER BY guild_id, position, id;

-- name: NextChannelPosition :one
SELECT COALESCE(max(position) + 1, 0)::int FROM channels WHERE guild_id = $1;

-- name: UpdateChannel :one
UPDATE channels SET name = $2, position = $3, parent_id = $4, topic = $5 WHERE id = $1
RETURNING *;

-- name: DeleteChannel :execrows
DELETE FROM channels WHERE id = $1;
