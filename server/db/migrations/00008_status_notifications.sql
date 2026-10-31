-- +goose Up
-- Status (Não perturbar, Invisível, status personalizado) e silenciar/nível de notificação
-- (adicional fora do SPEC). Aditiva: colunas com default constante (o Postgres não reescreve a
-- tabela) ou NULL, e uma tabela nova.

-- status_pref é a preferência escolhida pela pessoa; "ausente" continua automático (por inatividade).
-- O status personalizado expira no servidor: expires_at vencido é tratado como "sem status" na leitura.
ALTER TABLE users ADD COLUMN status_pref text NOT NULL DEFAULT 'online'
    CHECK (status_pref IN ('online', 'dnd', 'invisible'));
ALTER TABLE users ADD COLUMN custom_status_text text NULL CHECK (char_length(custom_status_text) <= 128);
ALTER TABLE users ADD COLUMN custom_status_emoji text NULL CHECK (char_length(custom_status_emoji) <= 32);
ALTER TABLE users ADD COLUMN custom_status_expires_at timestamptz NULL;

-- Uma linha por (usuário, servidor ou canal/DM) só quando algo difere do padrão. Sem FK de propósito
-- para o alvo (servidor, canal ou DM): linhas órfãs são inofensivas e o alvo é validado na escrita.
-- muted + muted_until: muted sem muted_until = "até reativar"; com muted_until vale até esse instante
-- (vencido = não silenciado, sem precisar de job). level NULL = herda (canal -> servidor -> padrão).
CREATE TABLE notification_settings (
    user_id     bigint      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    scope       text        NOT NULL CHECK (scope IN ('guild', 'channel')),
    target_id   bigint      NOT NULL,
    muted       boolean     NOT NULL DEFAULT false,
    muted_until timestamptz NULL,
    level       text        NULL CHECK (level IN ('all', 'mentions', 'none')),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, scope, target_id)
);

-- +goose Down
DROP TABLE notification_settings;
ALTER TABLE users DROP COLUMN custom_status_expires_at;
ALTER TABLE users DROP COLUMN custom_status_emoji;
ALTER TABLE users DROP COLUMN custom_status_text;
ALTER TABLE users DROP COLUMN status_pref;
