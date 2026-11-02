-- name: CreateUser :one
INSERT INTO users (id, email, username, password_hash)
VALUES ($1, $2, $3, $4)
RETURNING *;

-- name: GetUserByID :one
SELECT * FROM users WHERE id = $1;

-- name: GetUserByEmail :one
SELECT * FROM users WHERE email = $1 AND deleted_at IS NULL;

-- name: UpdateUserProfile :one
UPDATE users
SET display_name = $2, avatar_key = $3, bio = $4, pronouns = $5, banner_key = $6, banner_color = $7
WHERE id = $1 AND deleted_at IS NULL
RETURNING *;

-- name: UpdateUserEmail :one
UPDATE users SET email = $2 WHERE id = $1 AND deleted_at IS NULL
RETURNING *;

-- name: UpdateUserPassword :exec
UPDATE users SET password_hash = $2 WHERE id = $1 AND deleted_at IS NULL;
