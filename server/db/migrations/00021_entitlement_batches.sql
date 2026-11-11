-- +goose Up
-- Concessão de plano em massa (adicional fora do SPEC). Aditiva: tabela nova e uma coluna NULL em entitlements
-- (o Postgres não reescreve a tabela). entitlement_batches é um lote: "dar N dias de um plano a todos". Serve de
-- marca de idempotência (o mesmo plano e prazo, não revogado, dentro de 24 h não se repete), de histórico para o
-- /admin e de alça para revogar o lote inteiro. granted_count = concessões criadas; skipped_count = pessoas ativas
-- puladas por já terem o mesmo plano ou um maior de forma permanente. revoked_at preenchido = lote revogado.
CREATE TABLE entitlement_batches (
    id            bigint      PRIMARY KEY,
    tier          text        NOT NULL CHECK (tier IN ('nitro', 'nitro_plus')),
    days          int         NOT NULL CHECK (days BETWEEN 1 AND 3650),
    created_by    bigint      NULL REFERENCES users (id) ON DELETE SET NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    granted_count int         NOT NULL DEFAULT 0,
    skipped_count int         NOT NULL DEFAULT 0,
    revoked_at    timestamptz NULL
);
-- Idempotência (mesmo plano e prazo recentes) e lista do /admin (mais recentes primeiro).
CREATE INDEX entitlement_batches_created_idx ON entitlement_batches (created_at DESC, id DESC);

-- Concessão criada por um lote. SET NULL para a concessão sobreviver se o lote for apagado à mão.
ALTER TABLE entitlements ADD COLUMN batch_id bigint NULL REFERENCES entitlement_batches (id) ON DELETE SET NULL;
CREATE INDEX entitlements_batch_idx ON entitlements (batch_id) WHERE batch_id IS NOT NULL;

-- +goose Down
DROP INDEX entitlements_batch_idx;
ALTER TABLE entitlements DROP COLUMN batch_id;
DROP TABLE entitlement_batches;
