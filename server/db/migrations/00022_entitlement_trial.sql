-- +goose Up
-- Período de cortesia (adicional fora do SPEC): toda conta nova ganha Nitro+ por 14 dias (configurável). Aditiva:
-- só troca o CHECK de entitlements.source para aceitar 'trial' e cria um índice único parcial que garante, no
-- banco, no máximo UMA concessão 'trial' por pessoa (inclusive revogada ou vencida: o período de cortesia não
-- volta nunca), o que torna a concessão idempotente mesmo sob corrida.
ALTER TABLE entitlements DROP CONSTRAINT entitlements_source_check;
ALTER TABLE entitlements ADD CONSTRAINT entitlements_source_check CHECK (source IN ('admin', 'code', 'payment', 'trial'));
CREATE UNIQUE INDEX entitlements_trial_once_idx ON entitlements (user_id) WHERE source = 'trial';

-- +goose Down
DROP INDEX entitlements_trial_once_idx;
DELETE FROM entitlements WHERE source = 'trial';
ALTER TABLE entitlements DROP CONSTRAINT entitlements_source_check;
ALTER TABLE entitlements ADD CONSTRAINT entitlements_source_check CHECK (source IN ('admin', 'code', 'payment'));
