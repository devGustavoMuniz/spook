-- +goose Up
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
    id            bigint PRIMARY KEY,
    email         citext      NOT NULL UNIQUE,
    username      citext      NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9_.]{2,32}$'),
    display_name  text        CHECK (char_length(display_name) <= 32),
    password_hash text        NOT NULL,
    avatar_key    text,
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- +goose Down
DROP TABLE users;
