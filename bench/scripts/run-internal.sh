#!/usr/bin/env bash
# Mede os DOIS backends por dentro do VPS, sem Cloudflare/túnel/internet, alternando antrax e Spook
# (healthz) e depois o login de cada um. Roda do SEU computador; cada medição executa no VPS via SSH, como o
# usuário dono do Docker rootless daquele app, com o k6 em container na rede Docker do app (ver vps-k6.sh).
#
# Uso: run-internal.sh <ssh-destino> <diretório-de-saída> [rodadas=3]
#   ex.: ANTRAX_NET=antrax_default ANTRAX_TARGET=http://edge:80 ANTRAX_HOST_HEADER=antrax.dottadigital.com \
#        ANTRAX_LOGIN_EMAIL=bench@… ANTRAX_LOGIN_PASSWORD=… \
#        bench/scripts/run-internal.sh gustavo@<vps> /tmp/bench-interno 3
#
# Obrigatórias: ANTRAX_NET (rede Docker do antrax) e ANTRAX_TARGET (URL interna; use vps-discover.sh).
# Opcionais:
#   SPOOK_USER=spook  ANTRAX_USER=antrax  SPOOK_NET=spook_default  SPOOK_TARGET=http://spook:8090
#   ANTRAX_HEALTH_PATH=/up  ANTRAX_HOST_HEADER  ANTRAX_FORWARDED_PROTO (https se HOST_HEADER definido)
#   ANTRAX_PUBLIC_ORIGIN=https://antrax.dottadigital.com
#   ANTRAX_LOGIN_EMAIL / ANTRAX_LOGIN_PASSWORD (conta de teste existente, sem 2FA; sem elas o login do antrax é pulado)
#   RATE DURATION (healthz)  LOGIN_RATE_PER_MIN LOGIN_DURATION (login)  PAUSE (20)  REMOTE_DIR (/tmp/spook-bench)
# Exige no VPS: ssh como gustavo e `sudo -iu <usuário>` sem senha (ou rode os passos à mão, ver bench/README.md).
set -euo pipefail

dest="${1:?uso: run-internal.sh <ssh-destino> <diretório-de-saída> [rodadas]}"
out="${2:?falta o diretório de saída}"
rounds="${3:-3}"

SSH="${SSH:-ssh}"
SPOOK_USER="${SPOOK_USER:-spook}"
ANTRAX_USER="${ANTRAX_USER:-antrax}"
SPOOK_NET="${SPOOK_NET:-spook_default}"
SPOOK_TARGET="${SPOOK_TARGET:-http://spook:8090}"
ANTRAX_NET="${ANTRAX_NET:?defina ANTRAX_NET (rede Docker do antrax); descubra com bench/scripts/vps-discover.sh}"
ANTRAX_TARGET="${ANTRAX_TARGET:?defina ANTRAX_TARGET (URL interna do antrax); descubra com bench/scripts/vps-discover.sh}"
ANTRAX_HEALTH_PATH="${ANTRAX_HEALTH_PATH:-/up}"
ANTRAX_PUBLIC_ORIGIN="${ANTRAX_PUBLIC_ORIGIN:-https://antrax.dottadigital.com}"
REMOTE_DIR="${REMOTE_DIR:-/tmp/spook-bench}"
PAUSE="${PAUSE:-20}"

cd "$(dirname "$0")/../.."
mkdir -p "$out"
out="$(cd "$out" && pwd)"

{
  echo "inicio=$(date '+%Y-%m-%d %H:%M:%S %z') (utc $(date -u '+%H:%M:%S'))"
  echo "tipo=interno (k6 em container na rede Docker de cada app, no VPS; sem Cloudflare/túnel)"
  echo "spook=$SPOOK_USER@$SPOOK_NET -> $SPOOK_TARGET"
  echo "antrax=$ANTRAX_USER@$ANTRAX_NET -> $ANTRAX_TARGET host=${ANTRAX_HOST_HEADER:-<padrão>}"
  echo "rodadas=$rounds"
} | tee "$out/meta-interno.txt"

# 1) envia bench/ para o VPS (legível por qualquer usuário, pois o k6 roda como spook/antrax)
tar -C bench -cz scenarios scripts | $SSH "$dest" \
  "rm -rf '$REMOTE_DIR' && mkdir -p '$REMOTE_DIR' && tar -xz -C '$REMOTE_DIR' && chmod -R a+rX '$REMOTE_DIR'"

# k6 <usuário> <rede> <nome> <cenário> <stdin|-> [args do k6...]  →  grava internal-<nome>.json e .log
k6() {
  local user="$1" net="$2" name="$3" scenario="$4" stdin_mode="$5"
  shift 5
  local cmd=(sudo -iu "$user" env)
  [ "$stdin_mode" = password ] && cmd+=(LOGIN_PASSWORD_STDIN=1)
  cmd+=("$REMOTE_DIR/scripts/vps-k6.sh" "internal-$name" "$net" "$scenario" "$@")
  local quoted
  quoted="$(printf '%q ' "${cmd[@]}")"

  echo "== internal-$name ($(date '+%H:%M:%S'))"
  local code=0
  if [ "$stdin_mode" = password ]; then
    printf '%s\n' "${ANTRAX_LOGIN_PASSWORD:-}" | $SSH "$dest" "$quoted" >"$out/internal-$name.stdout" 2>"$out/internal-$name.log" || code=$?
  else
    $SSH "$dest" "$quoted" </dev/null >"$out/internal-$name.stdout" 2>"$out/internal-$name.log" || code=$?
  fi
  sed -n "/^===SUMMARY-JSON internal-$name===\$/,/^===FIM===\$/p" "$out/internal-$name.stdout" \
    | sed '1d;$d' >"$out/internal-$name.json"
  rm -f "$out/internal-$name.stdout"
  [ -s "$out/internal-$name.json" ] || { echo "  FALHA: sem summary (veja internal-$name.log)"; return 1; }
  [ "$code" -eq 0 ] || echo "  (k6 saiu com código $code — veja internal-$name.log)"
  return 0
}

# argumentos de carga opcionais
health_load=(); [ -n "${RATE:-}" ] && health_load+=(-e "RATE=$RATE"); [ -n "${DURATION:-}" ] && health_load+=(-e "DURATION=$DURATION")
login_load=(); [ -n "${LOGIN_RATE_PER_MIN:-}" ] && login_load+=(-e "RATE_PER_MIN=$LOGIN_RATE_PER_MIN"); [ -n "${LOGIN_DURATION:-}" ] && login_load+=(-e "DURATION=$LOGIN_DURATION")

antrax_edge=()
[ -n "${ANTRAX_HOST_HEADER:-}" ] && antrax_edge+=(-e "HOST_HEADER=$ANTRAX_HOST_HEADER" -e "FORWARDED_PROTO=${ANTRAX_FORWARDED_PROTO:-https}")

# 2) pré-checagem: os dois alvos internos respondem? (1 req/s por 2 s)
echo "== pré-checagem"
k6 "$ANTRAX_USER" "$ANTRAX_NET" preflight-laravel baseline.js none -e "BASE_URL=$ANTRAX_TARGET" -e "HEALTH_PATH=$ANTRAX_HEALTH_PATH" -e RATE=1 -e DURATION=2s ${antrax_edge[@]+"${antrax_edge[@]}"} \
  || { echo "o antrax não respondeu em $ANTRAX_TARGET na rede $ANTRAX_NET; confira com vps-discover.sh"; exit 1; }
k6 "$SPOOK_USER" "$SPOOK_NET" preflight-spook baseline.js none -e "BASE_URL=$SPOOK_TARGET" -e HEALTH_PATH=/healthz -e RATE=1 -e DURATION=2s \
  || { echo "o Spook não respondeu em $SPOOK_TARGET na rede $SPOOK_NET"; exit 1; }
rm -f "$out"/internal-preflight-*.json "$out"/internal-preflight-*.log

# 3) healthz alternado
for r in $(seq 1 "$rounds"); do
  k6 "$ANTRAX_USER" "$ANTRAX_NET" "healthz-laravel-r$r" baseline.js none -e "BASE_URL=$ANTRAX_TARGET" -e "HEALTH_PATH=$ANTRAX_HEALTH_PATH" ${health_load[@]+"${health_load[@]}"} ${antrax_edge[@]+"${antrax_edge[@]}"} || true
  sleep "$PAUSE"
  k6 "$SPOOK_USER" "$SPOOK_NET" "healthz-spook-r$r" baseline.js none -e "BASE_URL=$SPOOK_TARGET" -e HEALTH_PATH=/healthz ${health_load[@]+"${health_load[@]}"} || true
  sleep "$PAUSE"
done

# 4) login: Spook sempre; antrax se houver conta de teste
for r in $(seq 1 "$rounds"); do
  k6 "$SPOOK_USER" "$SPOOK_NET" "login-spook-r$r" login.js none -e "BASE_URL=$SPOOK_TARGET" ${login_load[@]+"${login_load[@]}"} || true
  sleep "$PAUSE"
  if [ -n "${ANTRAX_LOGIN_EMAIL:-}" ] && [ -n "${ANTRAX_LOGIN_PASSWORD:-}" ]; then
    k6 "$ANTRAX_USER" "$ANTRAX_NET" "login-laravel-r$r" login-antrax.js password -e "BASE_URL=$ANTRAX_TARGET" -e "LOGIN_EMAIL=$ANTRAX_LOGIN_EMAIL" \
      -e "PUBLIC_ORIGIN=$ANTRAX_PUBLIC_ORIGIN" ${login_load[@]+"${login_load[@]}"} ${antrax_edge[@]+"${antrax_edge[@]}"} || true
    sleep "$PAUSE"
  fi
done
[ -n "${ANTRAX_LOGIN_EMAIL:-}" ] || echo "(login do antrax pulado: defina ANTRAX_LOGIN_EMAIL e ANTRAX_LOGIN_PASSWORD)"
echo "fim=$(date '+%Y-%m-%d %H:%M:%S %z')" | tee -a "$out/meta-interno.txt"
