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

## Fase 1 — RAM ociosa do backend

No VPS, como usuário `spook`, com o sistema sem tráfego há alguns minutos (depois de remover o usuário de
teste e esperar o GC assentar):

```sh
docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}' | grep spook-spook
```

Registre o valor do container `spook-spook-1` (meta do SPEC, RNF01: < 100 MB).

Resultados e modelo: `results/fase-1-spook-producao.md`.
