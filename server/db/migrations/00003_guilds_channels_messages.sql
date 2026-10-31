-- +goose Up
CREATE TABLE guilds (
    id         bigint PRIMARY KEY,
    name       text        NOT NULL CHECK (char_length(name) BETWEEN 2 AND 100),
    icon_key   text,
    owner_id   bigint      NOT NULL REFERENCES users (id),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE guild_members (
    guild_id  bigint      NOT NULL REFERENCES guilds (id) ON DELETE CASCADE,
    user_id   bigint      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    nickname  text        CHECK (char_length(nickname) <= 32),
    joined_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (guild_id, user_id)
);
CREATE INDEX guild_members_user_id_idx ON guild_members (user_id);

-- O cargo @everyone de cada servidor tem id = guild_id.
CREATE TABLE roles (
    id          bigint PRIMARY KEY,
    guild_id    bigint NOT NULL REFERENCES guilds (id) ON DELETE CASCADE,
    name        text   NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
    color       integer CHECK (color BETWEEN 0 AND 16777215),
    position    integer NOT NULL DEFAULT 0 CHECK (position >= 0),
    permissions bigint  NOT NULL DEFAULT 0 CHECK (permissions >= 0)
);
CREATE INDEX roles_guild_id_position_idx ON roles (guild_id, position);

CREATE TABLE member_roles (
    guild_id bigint NOT NULL,
    user_id  bigint NOT NULL,
    role_id  bigint NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
    PRIMARY KEY (guild_id, user_id, role_id),
    FOREIGN KEY (guild_id, user_id) REFERENCES guild_members (guild_id, user_id) ON DELETE CASCADE
);
CREATE INDEX member_roles_role_id_idx ON member_roles (role_id);

-- type: 0 texto, 1 voz, 2 categoria, 3 DM, 4 DM em grupo. guild_id é NULL só nas DMs.
CREATE TABLE channels (
    id              bigint PRIMARY KEY,
    type            smallint    NOT NULL CHECK (type BETWEEN 0 AND 4),
    guild_id        bigint      REFERENCES guilds (id) ON DELETE CASCADE,
    parent_id       bigint      REFERENCES channels (id) ON DELETE SET NULL,
    name            text        CHECK (char_length(name) BETWEEN 1 AND 100),
    position        integer     NOT NULL DEFAULT 0,
    owner_id        bigint      REFERENCES users (id),
    last_message_id bigint,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CHECK ((type IN (3, 4) AND guild_id IS NULL) OR (type < 3 AND guild_id IS NOT NULL AND name IS NOT NULL))
);
CREATE INDEX channels_guild_id_position_idx ON channels (guild_id, position);
CREATE INDEX channels_parent_id_idx ON channels (parent_id);

CREATE TABLE messages (
    id         bigint PRIMARY KEY,
    channel_id bigint NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    author_id  bigint NOT NULL REFERENCES users (id),
    content    text   NOT NULL CHECK (char_length(content) <= 2000),
    edited_at  timestamptz,
    deleted_at timestamptz
);
CREATE INDEX messages_channel_id_id_idx ON messages (channel_id, id DESC);

CREATE TABLE invites (
    code       text PRIMARY KEY CHECK (char_length(code) = 8),
    guild_id   bigint      NOT NULL REFERENCES guilds (id) ON DELETE CASCADE,
    creator_id bigint      NOT NULL REFERENCES users (id),
    max_uses   integer     CHECK (max_uses > 0),
    uses       integer     NOT NULL DEFAULT 0,
    expires_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invites_guild_id_idx ON invites (guild_id);

-- +goose Down
DROP TABLE invites;
DROP TABLE messages;
DROP TABLE channels;
DROP TABLE member_roles;
DROP TABLE roles;
DROP TABLE guild_members;
DROP TABLE guilds;
