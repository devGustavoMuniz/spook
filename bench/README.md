# Benchmarks

Cenários k6 reproduzíveis (RNF03). O mesmo cenário roda contra o Laravel (baseline) e o Spook.
Resultados ficam em `results/`.

## Fase 0 — baseline (`scenarios/baseline.js`)

Variáveis: `BASE_URL` (obrigatória), `HEALTH_PATH` (padrão `/healthz`), `RATE` (req/s, padrão 5)
e `DURATION` (padrão `60s`). A carga padrão é leve porque o antrax está em produção: não aumente
`RATE` contra ele sem avisar.

Rode da raiz do repositório, na sua máquina (só precisa de Docker):

```sh
# Laravel (antrax) — health em /up
docker run --rm -i -v "$PWD/bench:/bench" grafana/k6:1.3.0 run \
  -e BASE_URL=https://antrax.dottadigital.com -e HEALTH_PATH=/up \
  /bench/scenarios/baseline.js

# Spook — health em /healthz (disponível quando o Spook estiver publicado)
docker run --rm -i -v "$PWD/bench:/bench" grafana/k6:1.3.0 run \
  -e BASE_URL=https://spook.dottadigital.com -e HEALTH_PATH=/healthz \
  /bench/scenarios/baseline.js
```

Cole a saída em `results/fase-0-laravel-baseline.md` (modelo pronto lá). Para comparação válida,
rode no mesmo horário e da mesma rede para os dois domínios.
