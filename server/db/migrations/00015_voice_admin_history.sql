-- +goose Up
-- Histórico do painel administrativo (adicional fora do SPEC): uma amostra por minuto do LiveKit (lida do
-- Prometheus dele) e do gateway. Aditiva: só uma tabela nova. As agregações por hora e por dia são feitas na
-- leitura (date_bin) e cacheadas; a retenção (LIVEKIT_SAMPLES_RETENTION_DAYS, padrão 35) apaga em lote.
--
-- Os contadores (bytes, pacotes) são ACUMULADOS desde o boot do LiveKit, como o Prometheus os entrega; a
-- leitura soma os deltas e trata a queda do valor como reinício do contador. media = false quando o
-- Prometheus do LiveKit não respondeu: as colunas do LiveKit ficam nulas, mas as do gateway continuam.
CREATE TABLE livekit_samples (
    ts                timestamptz      PRIMARY KEY,
    media             boolean          NOT NULL,
    rooms             integer          NULL,
    participants      integer          NULL,
    tracks_published  integer          NULL,
    tracks_subscribed integer          NULL,
    bytes_in          double precision NULL,
    bytes_out         double precision NULL,
    packets_in        double precision NULL,
    packets_out       double precision NULL,
    loss_pct          double precision NULL,
    jitter_ms         double precision NULL,
    rtt_ms            double precision NULL,
    online_users      integer          NULL,
    connections       integer          NULL
);

-- +goose Down
DROP TABLE livekit_samples;
