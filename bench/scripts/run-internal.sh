#!/usr/bin/env bash
# Mede os DOIS backends por dentro do VPS, sem Cloudflare/túnel/internet, alternando antrax e Spook:
# healthz, endpoint autenticado leve (GET do usuário logado) e, só para o Spook, o login (sem comparação, ver README).
# Roda do SEU computador; cada medição executa no VPS via SSH, como o usuário dono do Docker rootless daquele app,
# com o k6 em container na rede Docker do app (ver vps-k6.sh).
#
# Uso: run-internal.sh <ssh-destino> <diretório-de-saída> [rodadas=3]
#   ex.: SPOOK_COOKIE='spook_session=…' ANTRAX_COOKIE='laravel_session=…; XSRF-TOKEN=…' \
#        bench/scripts/run-internal.sh gustavo@<vps> /tmp/bench-interno 3
#
# Cookies (header Cookie copiado do navegador, de um login descartável feito por você; ver me.js):
#   SPOOK_COOKIE e ANTRAX_COOKIE. Sem eles o cenário autenticado é pulado. Seguem por stdin, nunca na linha de comando.
# Padrões (alvo = a origem que o túnel da Cloudflare usa para cada hostname; confirme com vps-discover.sh):
#   ANTRAX_USER=antrax  ANTRAX_NET=antrax-prod_default  ANTRAX_TARGET=http://web:80
#   ANTRAX_HOST_HEADER=antrax.dottadigital.com  ANTRAX_FORWARDED_PROTO=https   (o que o túnel/Cloudflare repassam ao origin)
#   ANTRAX_HEALTH_PATH=/up  ANTRAX_ME_PATH=/settings/profile  (antrax: página Inertia, lida em JSON via X-Inertia)
#   SPOOK_USER=spook  SPOOK_NET=spook_default  SPOOK_TARGET=http://spook:8090  SPOOK_ME_PATH=/api/users/me
# Carga: RATE DURATION (healthz e autenticado)  LOGIN_RATE_PER_MIN LOGIN_DURATION (login do Spook)  PAUSE (20)  REMOTE_DIR
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
SPOOK_ME_PATH="${SPOOK_ME_PATH:-/api/users/me}"
ANTRAX_NET="${ANTRAX_NET:-antrax-prod_default}"
ANTRAX_TARGET="${ANTRAX_TARGET:-http://web:80}"
ANTRAX_HOST_HEADER="${ANTRAX_HOST_HEADER:-antrax.dottadigital.com}"
ANTRAX_FORWARDED_PROTO="${ANTRAX_FORWARDED_PROTO:-https}"
ANTRAX_HEALTH_PATH="${ANTRAX_HEALTH_PATH:-/up}"
ANTRAX_ME_PATH="${ANTRAX_ME_PATH:-/settings/profile}"
REMOTE_DIR="${REMOTE_DIR:-/tmp/spook-bench}"
PAUSE="${PAUSE:-20}"

cd "$(dirname "$0")/../.."
mkdir -p "$out"
out="$(cd "$out" && pwd)"

{
  echo "inicio=$(date '+%Y-%m-%d %H:%M:%S %z') (utc $(date -u '+%H:%M:%S'))"
  echo "tipo=interno (k6 em container na rede Docker de cada app, no VPS; sem Cloudflare/túnel)"
  echo "spook=$SPOOK_USER@$SPOOK_NET -> $SPOOK_TARGET"
  echo "antrax=$ANTRAX_USER@$ANTRAX_NET -> $ANTRAX_TARGET host=$ANTRAX_HOST_HEADER proto=$ANTRAX_FORWARDED_PROTO"
  echo "rodadas=$rounds"
} | tee "$out/meta-interno.txt"

# 1) envia bench/ para o VPS (legível por qualquer usuário, pois o k6 roda como spook/antrax)
tar -C bench -cz scenarios scripts | $SSH "$dest" \
  "rm -rf '$REMOTE_DIR' && mkdir -p '$REMOTE_DIR' && tar -xz -C '$REMOTE_DIR' && chmod -R a+rX '$REMOTE_DIR'"

# k6 <usuário> <rede> <nome> <cenário> <VAR-do-segredo|-> [args do k6...]  →  grava internal-<nome>.json e .log
# O valor do segredo (nome da variável em $5, ex.: SPOOK_COOKIE) vai por stdin e chega ao k6 como COOKIE.
k6() {
  local user="$1" net="$2" name="$3" scenario="$4" secret_var="$5"
  shift 5
  local cmd=(sudo -iu "$user" env)
  [ "$secret_var" != - ] && cmd+=(STDIN_SECRET=COOKIE)
  cmd+=("$REMOTE_DIR/scripts/vps-k6.sh" "internal-$name" "$net" "$scenario" "$@")
  local quoted
  quoted="$(printf '%q ' "${cmd[@]}")"

  echo "== internal-$name ($(date '+%H:%M:%S'))"
  local code=0
  if [ "$secret_var" != - ]; then
    printf '%s\n' "${!secret_var}" | $SSH "$dest" "$quoted" >"$out/internal-$name.stdout" 2>"$out/internal-$name.log" || code=$?
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
load=(); [ -n "${RATE:-}" ] && load+=(-e "RATE=$RATE"); [ -n "${DURATION:-}" ] && load+=(-e "DURATION=$DURATION")
login_load=(); [ -n "${LOGIN_RATE_PER_MIN:-}" ] && login_load+=(-e "RATE_PER_MIN=$LOGIN_RATE_PER_MIN"); [ -n "${LOGIN_DURATION:-}" ] && login_load+=(-e "DURATION=$LOGIN_DURATION")
antrax_edge=(-e "HOST_HEADER=$ANTRAX_HOST_HEADER" -e "FORWARDED_PROTO=$ANTRAX_FORWARDED_PROTO")
antrax_me=(-e "BASE_URL=$ANTRAX_TARGET" -e "ME_PATH=$ANTRAX_ME_PATH" -e ME_STYLE=inertia "${antrax_edge[@]}")
spook_me=(-e "BASE_URL=$SPOOK_TARGET" -e "ME_PATH=$SPOOK_ME_PATH" -e ME_STYLE=json)

have_me=0
if [ -n "${SPOOK_COOKIE:-}" ] && [ -n "${ANTRAX_COOKIE:-}" ]; then have_me=1; fi
[ "$have_me" = 1 ] || echo "(cenário autenticado pulado: defina SPOOK_COOKIE e ANTRAX_COOKIE)"

# 2) pré-checagem: alvos respondem e os cookies valem? (1 req/s por 2 s)
echo "== pré-checagem"
k6 "$ANTRAX_USER" "$ANTRAX_NET" preflight-laravel baseline.js - -e "BASE_URL=$ANTRAX_TARGET" -e "HEALTH_PATH=$ANTRAX_HEALTH_PATH" -e RATE=1 -e DURATION=2s "${antrax_edge[@]}" \
  || { echo "o antrax não respondeu em $ANTRAX_TARGET (rede $ANTRAX_NET, Host $ANTRAX_HOST_HEADER); confira com vps-discover.sh"; exit 1; }
k6 "$SPOOK_USER" "$SPOOK_NET" preflight-spook baseline.js - -e "BASE_URL=$SPOOK_TARGET" -e HEALTH_PATH=/healthz -e RATE=1 -e DURATION=2s \
  || { echo "o Spook não respondeu em $SPOOK_TARGET na rede $SPOOK_NET"; exit 1; }
if [ "$have_me" = 1 ]; then
  k6 "$ANTRAX_USER" "$ANTRAX_NET" preflight-me-laravel me.js ANTRAX_COOKIE "${antrax_me[@]}" -e RATE=1 -e DURATION=2s \
    || { echo "cookie do antrax recusado em $ANTRAX_ME_PATH (expirou? veja internal-preflight-me-laravel.log)"; exit 1; }
  k6 "$SPOOK_USER" "$SPOOK_NET" preflight-me-spook me.js SPOOK_COOKIE "${spook_me[@]}" -e RATE=1 -e DURATION=2s \
    || { echo "cookie do Spook recusado em $SPOOK_ME_PATH (expirou? veja internal-preflight-me-spook.log)"; exit 1; }
fi
rm -f "$out"/internal-preflight-*.json "$out"/internal-preflight-*.log

# 3) healthz e endpoint autenticado, alternando antrax e Spook
for r in $(seq 1 "$rounds"); do
  k6 "$ANTRAX_USER" "$ANTRAX_NET" "healthz-laravel-r$r" baseline.js - -e "BASE_URL=$ANTRAX_TARGET" -e "HEALTH_PATH=$ANTRAX_HEALTH_PATH" ${load[@]+"${load[@]}"} "${antrax_edge[@]}" || true
  sleep "$PAUSE"
  k6 "$SPOOK_USER" "$SPOOK_NET" "healthz-spook-r$r" baseline.js - -e "BASE_URL=$SPOOK_TARGET" -e HEALTH_PATH=/healthz ${load[@]+"${load[@]}"} || true
  sleep "$PAUSE"
  if [ "$have_me" = 1 ]; then
    k6 "$ANTRAX_USER" "$ANTRAX_NET" "me-laravel-r$r" me.js ANTRAX_COOKIE "${antrax_me[@]}" ${load[@]+"${load[@]}"} || true
    sleep "$PAUSE"
    k6 "$SPOOK_USER" "$SPOOK_NET" "me-spook-r$r" me.js SPOOK_COOKIE "${spook_me[@]}" ${load[@]+"${load[@]}"} || true
    sleep "$PAUSE"
  fi
done

# 4) login: só o Spook (a latência de login entre os dois sistemas não é comparada; ver README)
for r in $(seq 1 "$rounds"); do
  k6 "$SPOOK_USER" "$SPOOK_NET" "login-spook-r$r" login.js - -e "BASE_URL=$SPOOK_TARGET" ${login_load[@]+"${login_load[@]}"} || true
  sleep "$PAUSE"
done
echo "fim=$(date '+%Y-%m-%d %H:%M:%S %z')" | tee -a "$out/meta-interno.txt"
