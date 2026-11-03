-- +goose Up
-- E-mail e login social (adicional fora do SPEC). Aditiva: só colunas NULL e tabelas novas.
--
-- Verificação de e-mail: NULL = não verificado (contas existentes entram assim; nada é bloqueado a menos que
-- REQUIRE_EMAIL_VERIFICATION=true). pending_email é o endereço novo aguardando confirmação.
ALTER TABLE users ADD COLUMN email_verified_at timestamptz NULL;
ALTER TABLE users ADD COLUMN pending_email citext NULL;

-- Tokens de uso único dos fluxos por e-mail. Só o hash SHA-256 é guardado (um vazamento do banco não entrega
-- links válidos). kind: verify | email_change | password_reset. email = endereço que o token confirma.
CREATE TABLE email_tokens (
    id         bigint PRIMARY KEY,
    user_id    bigint      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    kind       text        NOT NULL CHECK (kind IN ('verify', 'email_change', 'password_reset')),
    email      citext      NOT NULL,
    token_hash bytea       NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    used_at    timestamptz NULL,
    sent_at    timestamptz NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_tokens_user_kind_idx ON email_tokens (user_id, kind);
CREATE INDEX email_tokens_expires_idx ON email_tokens (expires_at);

-- Contas sociais vinculadas (Google, Discord). Os tokens de acesso do provedor NUNCA são guardados.
CREATE TABLE social_accounts (
    id               bigint PRIMARY KEY,
    user_id          bigint      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    provider         text        NOT NULL CHECK (provider IN ('google', 'discord')),
    provider_user_id text        NOT NULL,
    email            citext      NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (provider, provider_user_id),
    UNIQUE (user_id, provider)
);

-- Cadastro social pendente: o provedor confirmou a identidade, falta a pessoa escolher o username.
-- O token do cookie é guardado só como hash; vale 15 min.
CREATE TABLE social_signups (
    token_hash       bytea       PRIMARY KEY,
    provider         text        NOT NULL,
    provider_user_id text        NOT NULL,
    email            citext      NOT NULL,
    display_name     text        NULL,
    suggested        text        NOT NULL DEFAULT '',
    expires_at       timestamptz NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX social_signups_expires_idx ON social_signups (expires_at);

-- Login do desktop pelo navegador (handoff PKCE): código de uso único, 60 s.
CREATE TABLE desktop_login_codes (
    code_hash      bytea       PRIMARY KEY,
    user_id        bigint      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    code_challenge text        NOT NULL,
    expires_at     timestamptz NOT NULL,
    used_at        timestamptz NULL,
    created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX desktop_login_codes_expires_idx ON desktop_login_codes (expires_at);

-- +goose Down
DROP TABLE desktop_login_codes;
DROP TABLE social_signups;
DROP TABLE social_accounts;
DROP TABLE email_tokens;
ALTER TABLE users DROP COLUMN pending_email;
ALTER TABLE users DROP COLUMN email_verified_at;
