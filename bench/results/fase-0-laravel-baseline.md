# Fase 0 — Baseline do Laravel (antrax)

**Status: REGISTRADO** (30/10/2026). Medido em produção, contra `antrax.dottadigital.com`, que roda no mesmo VPS e no
mesmo padrão de deploy do Spook (SPEC, RNF03). Resultados do Spook, lado a lado: [`fase-1-spook-producao.md`](./fase-1-spook-producao.md).

Há **dois tipos de medição** (ver `bench/README.md`): **Internet** (experiência do usuário: Cloudflare + túnel, a partir da sua
máquina) e **Interno** (backend: k6 na rede Docker do app, no VPS, sem Cloudflare/túnel). Este arquivo guarda o lado do antrax;
o comparativo está no arquivo da Fase 1.

## Contexto da execução
| Campo | Valor |
| --- | --- |
| Data/hora (com fuso) | 30/10/2026, 23:00:14 a 23:24:22 (UTC−03:00; 02:00:14 a 02:24:22 UTC) |
| Origem | Mac do dono (macOS, Darwin 25.3.0 arm64) executando o k6 em Docker Desktop (Docker 29.2.1); rede local do dono, fora do VPS |
| Versão do k6 | `grafana/k6:1.3.0` |
| Execução | `bench/scripts/run-alternating.sh`, 3 rodadas alternadas (antrax, Spook, antrax, Spook…), 20 s de pausa entre execuções |
| Carga (healthz) | `baseline.js`, `RATE=5` req/s por `DURATION=60s` (300 req por execução), carga leve por ser produção |
| Dados brutos | [`raw/2026-10-30-producao/`](./raw/2026-10-30-producao) (summary JSON e log de cada execução) |
| Alvo | `https://antrax.dottadigital.com/up` |
| Commit/versão do antrax | não informado (produção na data da medição) |

## Comando
```sh
docker run --rm -i -v "$PWD/bench:/bench:ro" -v "$PWD/out:/out" grafana/k6:1.3.0 run --summary-export=/out/healthz-laravel-rN.json \
  -e BASE_URL=https://antrax.dottadigital.com -e HEALTH_PATH=/up -e RATE=5 -e DURATION=60s \
  /bench/scenarios/baseline.js
```
(o `run-alternating.sh` repete isso 3 vezes, intercalando com o Spook; `node bench/scripts/summarize.mjs <dir>` gera as tabelas.)

## Internet (experiência do usuário) — mediana das 3 rodadas, medido em 30/10/2026
| Métrica | Valor |
| --- | --- |
| http_reqs (total e req/s) | 301 por execução, 5,01 req/s |
| http_req_failed | 0,00% (0 falhas nas 3 rodadas) |
| http_req_duration avg | 70,8 ms |
| http_req_duration med (p50) | **58,6 ms** |
| http_req_duration p(90) | 120,2 ms |
| http_req_duration p(95) | **132,6 ms** |
| http_req_duration p(99) | **142,7 ms** |
| http_req_duration max | 213,7 ms |

### Por rodada
| Rodada | reqs | req/s | falhas | avg | p50 | p90 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 300 | 5.00 | 0.00% (0) | 82.6 ms | 70.1 ms | 131.4 ms | 146.5 ms | 185.4 ms | 216.9 ms |
| 2 | 301 | 5.01 | 0.00% (0) | 70.8 ms | 58.6 ms | 120.2 ms | 128.8 ms | 136.1 ms | 146.1 ms |
| 3 | 301 | 5.01 | 0.00% (0) | 62.9 ms | 52.3 ms | 114.5 ms | 132.6 ms | 142.7 ms | 213.7 ms |
| **mediana** | 301 | 5.01 | 0.00% | 70.8 ms | 58.6 ms | 120.2 ms | 132.6 ms | 142.7 ms | 213.7 ms |

## Interno (backend, sem Cloudflare/túnel) — PENDENTE

Rodar `bench/scripts/run-internal.sh` (ver `bench/README.md`, seção 3): k6 em container na rede Docker do antrax, no VPS, contra
a origem que o túnel usa para `antrax.dottadigital.com`. Preencher com `node bench/scripts/summarize.mjs`.

| Campo | Valor |
| --- | --- |
| Data/hora, origem | |
| Rede Docker / alvo interno / Host header | |
| Cenário | `baseline.js` (`/up`), 5 req/s por 60 s, 3 rodadas |

| Métrica (mediana de 3 rodadas) | Valor |
| --- | --- |
| http_req_duration p50 / p95 / p99 | |
| http_req_failed | |

## Observações
- O `/up` do Laravel mede principalmente o caminho de rede (origem → Cloudflare → túnel → app) mais o custo mínimo do
  framework; é um baseline de piso, não de uma operação de negócio. Os cenários de negócio entram a partir da Fase 2.
- Origem fora do VPS: a latência inclui a ida e volta até a borda da Cloudflare, igual para os dois sistemas.
- 3 rodadas de 60 s é amostra pequena: use os números para ordem de grandeza e tendência, não para diferenças de poucos ms.
