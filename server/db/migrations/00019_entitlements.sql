-- +goose Up
-- Nitro e Nitro+ (adicional fora do SPEC). Aditiva: tabelas e função novas, nada existente muda.
-- entitlements: concessões de plano pago. O plano efetivo de uma pessoa é o MAIOR entre as concessões não
-- revogadas e não vencidas (expires_at nulo = permanente). source diz de onde veio: admin (concedido no /admin),
-- code (código de resgate) ou payment (pagamento, reservado para uma tarefa futura). redeem_code_id liga a
-- concessão ao código que a gerou. expiry_notified_at marca que o job de vencimento já avisou a pessoa.
CREATE TABLE entitlements (
    id                 bigint      PRIMARY KEY,
    user_id            bigint      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    tier               text        NOT NULL CHECK (tier IN ('nitro', 'nitro_plus')),
    source             text        NOT NULL CHECK (source IN ('admin', 'code', 'payment')),
    expires_at         timestamptz NULL,
    granted_by         bigint      NULL REFERENCES users (id) ON DELETE SET NULL,
    redeem_code_id     bigint      NULL,
    revoked_at         timestamptz NULL,
    expiry_notified_at timestamptz NULL,
    created_at         timestamptz NOT NULL DEFAULT now()
);
-- Plano efetivo e "meu plano": só as concessões não revogadas de uma pessoa.
CREATE INDEX entitlements_user_live_idx ON entitlements (user_id) WHERE revoked_at IS NULL;
-- Job de vencimento: concessões finitas, não revogadas, ainda não avisadas.
CREATE INDEX entitlements_expiry_idx ON entitlements (expires_at) WHERE revoked_at IS NULL AND expiry_notified_at IS NULL AND expires_at IS NOT NULL;
-- Lista do /admin (mais recentes primeiro).
CREATE INDEX entitlements_created_idx ON entitlements (created_at DESC, id DESC);

-- redeem_codes: códigos de resgate gerados no /admin. Só o hash do código fica gravado (code_hash, único); o texto
-- aparece UMA vez, para quem gerou. code_hint são os 4 últimos caracteres, para o admin reconhecer o código.
-- days nulo = plano permanente. redeemed_by/redeemed_at preenchidos de forma atômica no resgate.
CREATE TABLE redeem_codes (
    id          bigint      PRIMARY KEY,
    code_hash   text        NOT NULL UNIQUE,
    code_hint   text        NOT NULL,
    tier        text        NOT NULL CHECK (tier IN ('nitro', 'nitro_plus')),
    days        int         NULL CHECK (days IS NULL OR days BETWEEN 1 AND 3650),
    created_by  bigint      NULL REFERENCES users (id) ON DELETE SET NULL,
    redeemed_by bigint      NULL REFERENCES users (id) ON DELETE SET NULL,
    redeemed_at timestamptz NULL,
    expires_at  timestamptz NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    CHECK ((redeemed_by IS NULL) OR (redeemed_at IS NOT NULL))
);
CREATE INDEX redeem_codes_created_idx ON redeem_codes (created_at DESC, id DESC);

-- user_plan(uid): o plano efetivo de uma pessoa ('free', 'nitro' ou 'nitro_plus') no instante da consulta. As
-- consultas que devolvem o perfil público de vários usuários (membros, autores, DMs) usam esta função; o cálculo
-- em Go (internal/plan.Effective) é o mesmo e um teste de integração garante que concordam.
-- +goose StatementBegin
CREATE FUNCTION user_plan(uid bigint) RETURNS text
LANGUAGE sql STABLE AS $$
    SELECT COALESCE((
        SELECT e.tier FROM entitlements e
        WHERE e.user_id = uid AND e.revoked_at IS NULL AND (e.expires_at IS NULL OR e.expires_at > now())
        ORDER BY CASE e.tier WHEN 'nitro_plus' THEN 2 ELSE 1 END DESC
        LIMIT 1
    ), 'free')
$$;
-- +goose StatementEnd

-- +goose Down
DROP FUNCTION user_plan(bigint);
DROP TABLE redeem_codes;
DROP TABLE entitlements;
