# Benchmarks

Cenários k6 reproduzíveis (RNF03). O mesmo cenário roda contra o Laravel (baseline, `antrax.dottadigital.com`)
e o Spook. Resultados ficam em `results/`. **A partir da Fase 1 as medições são feitas contra produção
no VPS** (SPEC, seção 8). Todos os comandos usam só Docker e podem ser rodados da sua máquina.

## Fase 0 — baseline de healthz (`scenarios/baseline.js`)

Variáveis: `BASE_URL` (obrigatória), `HEALTH_PATH` (padrão `/healthz`), `RATE` (req/s, padrão 5)
e `DURATION` (padrão `60s`). Carga leve de propósito: o antrax está em produção.

```sh
# Laravel (antrax) — health em /up
docker run --rm -i -v "$PWD/bench:/bench" grafana/k6:1.3.0 run \
  -e BASE_URL=https://antrax.dottadigital.com -e HEALTH_PATH=/up \
  /bench/scenarios/baseline.js

# Spook em produção — health em /healthz (MESMO cenário, para comparar)
docker run --rm -i -v "$PWD/bench:/bench" grafana/k6:1.3.0 run \
  -e BASE_URL=https://spook.dottadigital.com -e HEALTH_PATH=/healthz \
  /bench/scenarios/baseline.js
```

Rode os dois no mesmo horário e da mesma rede. Resultado do Laravel: `results/fase-0-laravel-baseline.md`.

## Fase 1 — login (`scenarios/login.js`)

Mede o p95 de `POST /api/auth/login`. O backend limita `/api/auth/*` a **10 req/min por IP**
(burst 10), então o padrão é leve: `RATE_PER_MIN=8` por `DURATION=5m` (~40 amostras). Passar de
10/min mede respostas 429, não o login (o threshold `http_req_failed` acusa).

```sh
docker run --rm -i -v "$PWD/bench:/bench" grafana/k6:1.3.0 run \
  -e BASE_URL=https://spook.dottadigital.com \
  /bench/scenarios/login.js
```

O `setup` cadastra um usuário de teste (`bench-…@bench.spook.invalid`). Para removê-lo depois, no VPS
como usuário `spook` (com `DOCKER_HOST` apontando para o Docker rootless, ver `deploy/README.md`):

```sh
cd /srv/spook/prod && docker compose --env-file .env -f deploy/docker-compose.prod.yml exec postgres \
  psql -U spook -d spook -c "DELETE FROM users WHERE email LIKE '%@bench.spook.invalid'"
```

## Fase 1 — RAM ociosa (mediana de N amostras)

`scripts/docker-stats.sh [amostras=10] [intervalo=5] [filtro-regex=.]` coleta N amostras de `docker stats --no-stream`,
converte para MiB e imprime a **mediana por container** e a soma da stack (`STATS_CSV=1` despeja as amostras brutas em
stderr). Rode com o sistema sem tráfego (sem k6 nem deploy em andamento).

O Docker é rootless por usuário, então o script precisa rodar como o dono do daemon. Do seu computador, **como `gustavo`**,
sem copiar nada para o servidor (o script vai por stdin):

```sh
# Spook (10 amostras, uma a cada 5 s)
ssh gustavo@<vps> "sudo -iu spook bash -s -- 10 5" < bench/scripts/docker-stats.sh

# Antrax, para comparar (mesmo comando, outro usuário)
ssh gustavo@<vps> "sudo -iu antrax bash -s -- 10 5" < bench/scripts/docker-stats.sh
```

(Se o `sudo` pedir senha ou terminal, use `ssh -t` ou entre no servidor e rode `sudo -iu spook`, colando o script.)
Registre o container `spook-spook-1` (meta do SPEC, RNF01: < 100 MB) e a soma da stack. Para o backend do antrax, some
`app + reverb + queue + scheduler`.

## Rodando tudo contra produção (3 rodadas alternadas)

```sh
bench/scripts/run-alternating.sh /tmp/bench-$(date +%F) 3          # healthz antrax/Spook alternados + login do Spook
node bench/scripts/summarize.mjs /tmp/bench-$(date +%F)            # tabelas Markdown com a mediana das rodadas
node scripts/smoke-prod.mjs https://spook.dottadigital.com         # smoke da API + avatar direto no storage
```

`run-alternating.sh` leva ~25 min (6 execuções de 60 s e 3 de 5 min) e aceita `RATE`, `DURATION`, `LOGIN_RATE_PER_MIN`,
`LOGIN_DURATION`, `ANTRAX_URL`, `SPOOK_URL`, `PAUSE`. Cada execução grava `<nome>.json` (summary do k6) e `<nome>.log`.
Os dados brutos da primeira medição estão em `results/raw/2026-10-30-producao/`.

**Cada execução do `login.js` cadastra um usuário de teste e o `smoke-prod.mjs` cria um usuário descartável; não há rota de
excluir conta.** Os usernames aparecem no log do k6 (`usuario_de_teste ...`) e na saída do smoke.

Resultados e modelos: `results/fase-0-laravel-baseline.md` e `results/fase-1-spook-producao.md`.
