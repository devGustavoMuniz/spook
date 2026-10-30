# Fase 1 — Spook em produção (ao lado do baseline do Laravel)

**Status: ENTREGUE, AGUARDANDO VALIDAÇÃO** — trocar por `REGISTRADO` após colar os resultados.
Baseline do Laravel (antrax): ver [`fase-0-laravel-baseline.md`](./fase-0-laravel-baseline.md).

## Contexto
| Campo | Valor |
| --- | --- |
| Data/hora (com fuso) | |
| Origem (máquina/rede) | |
| Commit/imagem do Spook (`SPOOK_IMAGE`) | |
| Versão do k6 | grafana/k6:1.3.0 |

## 1. healthz — mesmo cenário do baseline (`baseline.js`, 5 req/s por 60s)
Comandos em `bench/README.md`. Rode Laravel e Spook no mesmo horário e da mesma rede.

| Métrica | Laravel (antrax `/up`) | Spook (`/healthz`) |
| --- | --- | --- |
| http_reqs (total e req/s) | | |
| http_req_failed | | |
| http_req_duration avg | | |
| http_req_duration med | | |
| http_req_duration p(90) | | |
| http_req_duration p(95) | | |
| http_req_duration p(99) | | |
| http_req_duration max | | |

## 2. Login (`login.js`, 8/min por 5m)
| Métrica | Spook |
| --- | --- |
| login_duration avg | |
| login_duration med | |
| login_duration p(95) | |
| login_duration p(99) | |
| http_req_failed (deve ser 0%; 429 indica taxa acima do limite) | |

## 3. RAM ociosa do backend (`docker stats`, container `spook-spook-1`)
| Métrica | Valor |
| --- | --- |
| MemUsage | |
| Meta (SPEC, RNF01) | < 100 MB |

<details><summary>Saídas completas do k6 e do docker stats</summary>

```
(colar aqui)
```

</details>

## Observações
(Cloudflare/túnel na frente, carga concorrente no VPS, usuário de teste removido? etc.)
