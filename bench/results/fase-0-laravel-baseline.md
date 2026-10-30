# Fase 0 — Baseline do Laravel (antrax)

**Status: PENDENTE** — trocar por `REGISTRADO` após colar os resultados.

## Contexto da execução
| Campo | Valor |
| --- | --- |
| Data/hora (com fuso) | |
| Origem (máquina/rede) | |
| Alvo | https://antrax.dottadigital.com/up |
| Commit/versão do antrax | |
| Versão do k6 | grafana/k6:1.3.0 |
| `RATE` / `DURATION` | 5 / 60s (padrão) |

## Comando
```sh
docker run --rm -i -v "$PWD/bench:/bench" grafana/k6:1.3.0 run \
  -e BASE_URL=https://antrax.dottadigital.com -e HEALTH_PATH=/up \
  /bench/scenarios/baseline.js
```

## Resultados
| Métrica | Valor |
| --- | --- |
| http_reqs (total e req/s) | |
| http_req_failed | |
| http_req_duration avg | |
| http_req_duration med | |
| http_req_duration p(90) | |
| http_req_duration p(95) | |
| http_req_duration p(99) | |
| http_req_duration max | |

<details><summary>Saída completa do k6</summary>

```
(colar aqui)
```

</details>

## Observações
(cache, CDN/Cloudflare na frente, carga concorrente no VPS etc.)
