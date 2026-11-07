-- +goose Up
-- Adicional: sessão persistente ("Manter conectado") e lista de sessões ativas. Aditiva: só colunas novas.
-- remember = true: validade longa e cookie persistente; false: validade curta e cookie de sessão do navegador.
-- last_seen_at é o último uso/renovação (a validade desliza a partir dele, no máximo 1 vez por hora).
-- As sessões já existentes viram "lembradas" (tinham 30 dias) com o último uso = criação.
ALTER TABLE sessions ADD COLUMN remember boolean NOT NULL DEFAULT true;
ALTER TABLE sessions ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT now();
UPDATE sessions SET last_seen_at = created_at;

-- +goose Down
ALTER TABLE sessions DROP COLUMN last_seen_at;
ALTER TABLE sessions DROP COLUMN remember;
