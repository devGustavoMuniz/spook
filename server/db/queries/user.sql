-- name: CreateUser :one
INSERT INTO users (id, email, username, password_hash)
VALUES ($1, $2, $3, $4)
RETURNING *;

-- name: GetUserByID :one
SELECT * FROM users WHERE id = $1;

-- name: GetUserByEmail :one
SELECT * FROM users WHERE email = $1;

-- name: UpdateUserProfile :one
UPDATE users
SET display_name = $2, avatar_key = $3
WHERE id = $1
RETURNING *;
