#!/usr/bin/env bash
# Medição PELA INTERNET ("experiência do usuário"): roda os cenários k6 da sua máquina contra os domínios públicos
# (Cloudflare + túnel), alternando Laravel e Spook, e depois o login de cada um. Grava um summary JSON por execução.
# Carga leve de propósito: o antrax também é produção. A medição do BACKEND, sem rede, é o run-internal.sh.
#
# Uso: bench/scripts/run-alternating.sh <diretório-de-saída> [rodadas=3]
# Variáveis: ANTRAX_URL, SPOOK_URL, RATE (5), DURATION (60s), LOGIN_RATE_PER_MIN (4), LOGIN_DURATION (6m),
#            PAUSE (20s entre execuções), K6_IMAGE.
#            ANTRAX_LOGIN_EMAIL e ANTRAX_LOGIN_PASSWORD: conta de teste existente (sem 2FA) no antrax; sem elas o
#            login do antrax é pulado. A taxa de login é a mesma nos dois sistemas (o antrax limita a 5/min).
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
  docker run --rm -i ${LOGIN_PASSWORD:+-e LOGIN_PASSWORD} -v "$PWD/bench:/bench:ro" -v "$out:/out" "$K6_IMAGE" run \
    --summary-export="/out/$name.json" "$@" "/bench/scenarios/$script" >"$out/$name.log" 2>&1 || echo "  (k6 saiu com código $? — veja $name.log)"
  sleep "$PAUSE"
}

for r in $(seq 1 "$rounds"); do
  k6 "healthz-laravel-r$r" baseline.js -e "BASE_URL=$ANTRAX_URL" -e HEALTH_PATH=/up -e "RATE=${RATE:-5}" -e "DURATION=${DURATION:-60s}"
  k6 "healthz-spook-r$r"   baseline.js -e "BASE_URL=$SPOOK_URL"  -e HEALTH_PATH=/healthz -e "RATE=${RATE:-5}" -e "DURATION=${DURATION:-60s}"
done
for r in $(seq 1 "$rounds"); do
  k6 "login-spook-r$r" login.js -e "BASE_URL=$SPOOK_URL" -e "RATE_PER_MIN=${LOGIN_RATE_PER_MIN:-4}" -e "DURATION=${LOGIN_DURATION:-6m}"
  if [ -n "${ANTRAX_LOGIN_EMAIL:-}" ] && [ -n "${ANTRAX_LOGIN_PASSWORD:-}" ]; then
    # a senha vai pelo ambiente do docker (-e LOGIN_PASSWORD sem valor): não aparece na linha de comando
    LOGIN_PASSWORD="$ANTRAX_LOGIN_PASSWORD" k6 "login-laravel-r$r" login-antrax.js -e "BASE_URL=$ANTRAX_URL" \
      -e "LOGIN_EMAIL=$ANTRAX_LOGIN_EMAIL" -e "RATE_PER_MIN=${LOGIN_RATE_PER_MIN:-4}" -e "DURATION=${LOGIN_DURATION:-6m}"
  fi
done
echo "fim=$(date '+%Y-%m-%d %H:%M:%S %z')" | tee -a "$out/meta.txt"
