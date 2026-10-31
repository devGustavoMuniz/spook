#!/usr/bin/env bash
# Roda os cenários k6 de forma alternada (Laravel, Spook, Laravel, Spook...) e depois o login do Spook,
# gravando um summary JSON por execução. Carga leve de propósito: o antrax também é produção.
#
# Uso: bench/scripts/run-alternating.sh <diretório-de-saída> [rodadas=3]
# Variáveis: ANTRAX_URL, SPOOK_URL, RATE (5), DURATION (60s), LOGIN_RATE_PER_MIN (8), LOGIN_DURATION (5m),
#            PAUSE (20s entre execuções), K6_IMAGE.
# Depois: node bench/scripts/summarize.mjs <diretório-de-saída>
set -euo pipefail

out="${1:?uso: run-alternating.sh <diretório-de-saída> [rodadas]}"
rounds="${2:-3}"
ANTRAX_URL="${ANTRAX_URL:-https://antrax.dottadigital.com}"
SPOOK_URL="${SPOOK_URL:-https://spook.dottadigital.com}"
K6_IMAGE="${K6_IMAGE:-grafana/k6:1.3.0}"
PAUSE="${PAUSE:-20}"

cd "$(dirname "$0")/../.."
mkdir -p "$out"
out="$(cd "$out" && pwd)"
{
  echo "inicio=$(date '+%Y-%m-%d %H:%M:%S %z') (utc $(date -u '+%H:%M:%S'))"
  echo "origem=$(uname -srm); $(docker --version)"
  echo "k6=$K6_IMAGE rodadas=$rounds RATE=${RATE:-5} DURATION=${DURATION:-60s}"
} | tee "$out/meta.txt"

k6() { # k6 <nome> <script> [-e VAR=valor ...]
  local name="$1" script="$2"; shift 2
  echo "== $name ($(date '+%H:%M:%S'))"
  docker run --rm -i -v "$PWD/bench:/bench:ro" -v "$out:/out" "$K6_IMAGE" run \
    --summary-export="/out/$name.json" "$@" "/bench/scenarios/$script" >"$out/$name.log" 2>&1 || echo "  (k6 saiu com código $? — veja $name.log)"
  sleep "$PAUSE"
}

for r in $(seq 1 "$rounds"); do
  k6 "healthz-laravel-r$r" baseline.js -e "BASE_URL=$ANTRAX_URL" -e HEALTH_PATH=/up -e "RATE=${RATE:-5}" -e "DURATION=${DURATION:-60s}"
  k6 "healthz-spook-r$r"   baseline.js -e "BASE_URL=$SPOOK_URL"  -e HEALTH_PATH=/healthz -e "RATE=${RATE:-5}" -e "DURATION=${DURATION:-60s}"
done
for r in $(seq 1 "$rounds"); do
  k6 "login-spook-r$r" login.js -e "BASE_URL=$SPOOK_URL" -e "RATE_PER_MIN=${LOGIN_RATE_PER_MIN:-8}" -e "DURATION=${LOGIN_DURATION:-5m}"
done
echo "fim=$(date '+%Y-%m-%d %H:%M:%S %z')" | tee -a "$out/meta.txt"
