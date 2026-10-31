#!/usr/bin/env bash
# Roda UM cenário k6 dentro da rede Docker do dono do daemon, para falar direto com o serviço interno
# (sem Cloudflare nem túnel). Executa NO VPS, como o usuário dono do Docker rootless (spook ou antrax).
#
# Por que assim: o Docker é rootless por usuário, então a rede dos containers vive no namespace de rede daquele
# daemon e NÃO é alcançável a partir do host (nem como gustavo, nem como root). Só quem está na mesma rede
# Docker enxerga `http://spook:8090`. Por isso o k6 também roda num container, na rede do app.
#
# Uso: vps-k6.sh <nome> <rede-docker> <cenário.js> [args do k6, ex.: -e BASE_URL=http://spook:8090 ...]
# Variáveis: BENCH_DIR (padrão: pasta bench/ deste script), K6_IMAGE, K6_CPUS (0.25), K6_MEM (192m),
#            LOGIN_PASSWORD_STDIN=1 (lê a senha da 1ª linha do stdin, para não ir na linha de comando).
# Saída: o log do k6 vai para stderr; o summary JSON vai para stdout entre os marcadores
#        `===SUMMARY-JSON <nome>===` e `===FIM===`. O código de saída é o do k6 (99 = threshold estourado).
#
# Atenção: o container do k6 consome do MESMO slice (CPU/memória) do app que está medindo. Com carga leve é
# desprezível; para cargas altas (Fase 3 em diante) isso precisa ser reavaliado. Os limites acima o contêm.
set -euo pipefail

name="${1:?uso: vps-k6.sh <nome> <rede-docker> <cenário.js> [args do k6]}"
net="${2:?falta a rede docker}"
scenario="${3:?falta o cenário (ex.: baseline.js)}"
shift 3

bench_dir="${BENCH_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
k6_image="${K6_IMAGE:-grafana/k6:1.3.0}"

uid="$(id -u)"
if [ -z "${DOCKER_HOST:-}" ] && [ -S "/run/user/$uid/docker.sock" ]; then
  DOCKER_HOST="unix:///run/user/$uid/docker.sock"
  export DOCKER_HOST
fi

if [ "${LOGIN_PASSWORD_STDIN:-}" = 1 ]; then
  IFS= read -r LOGIN_PASSWORD
  export LOGIN_PASSWORD
fi

out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT

pass_env=()
[ -n "${LOGIN_PASSWORD:-}" ] && pass_env=(-e LOGIN_PASSWORD) # herda do ambiente: não aparece no `ps`

# --user 0: em Docker rootless o root do container é o próprio usuário no host, que pode escrever em $out
# (a imagem do k6 roda como uid 12345, que não consegue).
set +e
docker run --rm --user 0:0 --network "$net" --cpus "${K6_CPUS:-0.25}" --memory "${K6_MEM:-192m}" \
  ${pass_env[@]+"${pass_env[@]}"} \
  -v "$bench_dir:/bench:ro" -v "$out:/out" \
  "$k6_image" run --quiet --summary-export="/out/$name.json" "$@" "/bench/scenarios/$scenario" >&2
code=$?
set -e

if [ -s "$out/$name.json" ]; then
  echo "===SUMMARY-JSON $name==="
  cat "$out/$name.json"
  echo
  echo "===FIM==="
fi
exit "$code"
