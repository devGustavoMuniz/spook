-- Popula um canal de TESTE com muitas mensagens (histórico para o cenário messages.js).
-- NUNCA rode contra um canal de verdade nem sem entender o que faz: ele INSERE linhas direto na tabela.
--
-- Pré-requisitos: um servidor de teste com um canal de texto e um usuário de teste (crie pela API/web; pegue os IDs
-- na resposta de POST /api/guilds e GET /api/users/me).
--
-- Uso (psql, no Postgres do ambiente de teste):
--   psql "$DATABASE_URL" -v channel_id=<ID do canal> -v author_id=<ID do usuário> -v total=1000000 -f bench/scripts/seed-messages.sql
-- No Compose local:
--   docker exec -i spook-postgres-1 psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
--     -v channel_id=<ID> -v author_id=<ID> -v total=1000000 < bench/scripts/seed-messages.sql
--
-- Os IDs são gerados abaixo do ID do canal + total: como o ID do canal é um Snowflake (tempo << 22), mensagens enviadas depois
-- pela API têm IDs maiores e continuam "mais novas" que as semeadas. Rode uma vez por canal (reexecutar viola a PK).
-- Para limpar: DELETE FROM messages WHERE channel_id = :channel_id AND id <= :channel_id + :total;
\set ON_ERROR_STOP on
\timing on

INSERT INTO messages (id, channel_id, author_id, content)
SELECT :channel_id::bigint + g, :channel_id::bigint, :author_id::bigint, 'mensagem de teste ' || g
FROM generate_series(1, :total::int) AS g;

UPDATE channels SET last_message_id = :channel_id::bigint + :total::int
WHERE id = :channel_id::bigint AND (last_message_id IS NULL OR last_message_id < :channel_id::bigint + :total::int);

ANALYZE messages;

SELECT count(*) AS mensagens_no_canal FROM messages WHERE channel_id = :channel_id::bigint;
