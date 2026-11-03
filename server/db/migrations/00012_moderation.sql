-- +goose Up
-- Moderação e permissões (adicional fora do SPEC). Aditiva: tabelas novas, uma coluna com default e um ajuste
-- de dados explícito (CHANGE_NICKNAME no @everyone). Nenhum cargo existente ganha BAN_MEMBERS, MANAGE_NICKNAMES,
-- MUTE_MEMBERS, DISCONNECT_MEMBERS nem VIEW_AUDIT_LOG.

-- Banimentos. A linha existe mesmo quando a pessoa não é (mais) membro. banned_by vira NULL se a conta de
-- quem baniu for excluída; o banimento continua valendo.
CREATE TABLE guild_bans (
    guild_id   bigint      NOT NULL REFERENCES guilds (id) ON DELETE CASCADE,
    user_id    bigint      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    banned_by  bigint      NULL REFERENCES users (id) ON DELETE SET NULL,
    reason     text        NULL CHECK (reason IS NULL OR char_length(reason) <= 512),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (guild_id, user_id)
);
CREATE INDEX guild_bans_guild_order_idx ON guild_bans (guild_id, created_at DESC, user_id DESC);

-- Permissões por canal. target_type = 'role' (o @everyone é o cargo de ID igual ao do servidor) ou 'member'.
-- allow e deny nunca se sobrepõem. Sem FK em target_id (aponta para roles ou users conforme o tipo): o service
-- valida e o store limpa os overwrites do cargo excluído e do membro que sai do servidor.
CREATE TABLE channel_overwrites (
    channel_id  bigint NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    target_type text   NOT NULL CHECK (target_type IN ('role', 'member')),
    target_id   bigint NOT NULL,
    allow       bigint NOT NULL DEFAULT 0 CHECK (allow >= 0),
    deny        bigint NOT NULL DEFAULT 0 CHECK (deny >= 0),
    PRIMARY KEY (channel_id, target_type, target_id),
    CHECK (allow & deny = 0)
);
CREATE INDEX channel_overwrites_target_idx ON channel_overwrites (target_type, target_id);

-- Mute persistente aplicado pelo moderador (a voz o reaplica ao emitir o token).
ALTER TABLE guild_members ADD COLUMN voice_muted boolean NOT NULL DEFAULT false;

-- Registro de auditoria. actor_id NULL = conta excluída. changes é limitado a 4 KB.
CREATE TABLE audit_logs (
    id          bigint      PRIMARY KEY,
    guild_id    bigint      NOT NULL REFERENCES guilds (id) ON DELETE CASCADE,
    actor_id    bigint      NULL REFERENCES users (id) ON DELETE SET NULL,
    action      text        NOT NULL,
    target_type text        NULL,
    target_id   bigint      NULL,
    reason      text        NULL CHECK (reason IS NULL OR char_length(reason) <= 512),
    changes     jsonb       NULL CHECK (changes IS NULL OR octet_length(changes::text) <= 4096),
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_guild_id_idx ON audit_logs (guild_id, id DESC);
CREATE INDEX audit_logs_created_idx ON audit_logs (created_at);

-- Decisão explícita: o @everyone dos servidores existentes ganha CHANGE_NICKNAME (1<<14), igual aos servidores
-- novos. É a única permissão nova concedida pela migração.
UPDATE roles SET permissions = permissions | 16384 WHERE id = guild_id;

-- +goose Down
DROP TABLE audit_logs;
ALTER TABLE guild_members DROP COLUMN voice_muted;
DROP TABLE channel_overwrites;
DROP TABLE guild_bans;
