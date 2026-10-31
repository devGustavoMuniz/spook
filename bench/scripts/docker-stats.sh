#!/usr/bin/env bash
# Coleta N amostras de `docker stats --no-stream` e imprime a MEDIANA de memória por container e a soma da stack.
# Roda no host onde o Docker está (no VPS, o Docker é rootless por usuário: rode como o dono dele, ex.: spook).
#
# Uso: docker-stats.sh [amostras=10] [intervalo-em-segundos=5] [filtro-regex-de-nome=.]
# Saída: tabela em MiB (mediana de N amostras), soma das medianas e um CSV com todas as amostras em stderr
#        quando STATS_CSV=1.
#
# No VPS, como `gustavo` (sem copiar nada, o script vai por stdin):
#   ssh gustavo@<vps> "sudo -iu spook bash -s -- 10 5" < bench/scripts/docker-stats.sh
# Para o antrax, troque `spook` pelo usuário dele (antrax). Rode com o app ocioso: sem k6 nem deploy em andamento.
set -euo pipefail

samples="${1:-10}"
interval="${2:-5}"
filter="${3:-.}"
# Docker rootless: sem DOCKER_HOST, usa o socket do usuário atual se existir; senão, o contexto padrão do docker.
uid="$(id -u)"
if [ -z "${DOCKER_HOST:-}" ] && [ -S "/run/user/$uid/docker.sock" ]; then
  DOCKER_HOST="unix:///run/user/$uid/docker.sock"
  export DOCKER_HOST
fi

raw="$(mktemp)"
trap 'rm -f "$raw"' EXIT

for i in $(seq 1 "$samples"); do
  docker stats --no-stream --format '{{.Name}}|{{.MemUsage}}' | awk -F'|' -v i="$i" '{ print i "|" $1 "|" $2 }' >> "$raw"
  [ "$i" -lt "$samples" ] && sleep "$interval"
done

[ "${STATS_CSV:-0}" = 1 ] && cat "$raw" >&2

# MemUsage vem como "21.57MiB / 384MiB": converte o primeiro valor para MiB e tira a mediana por container.
awk -F'|' -v filter="$filter" -v samples="$samples" '
function to_mib(v,   n, u) {
  n = v + 0; u = v; sub(/^[0-9.]+/, "", u)
  if (u == "B")   return n / 1048576
  if (u == "kB" || u == "KB") return n * 1000 / 1048576
  if (u == "KiB") return n / 1024
  if (u == "MiB") return n
  if (u == "GiB") return n * 1024
  return n
}
$2 ~ filter { split($3, a, " / "); val[$2, ++cnt[$2]] = to_mib(a[1]); names[$2] = 1 }
END {
  total = 0; n = 0
  for (name in names) order[++n] = name
  for (i = 1; i <= n; i++) for (j = i + 1; j <= n; j++) if (order[j] < order[i]) { t = order[i]; order[i] = order[j]; order[j] = t }
  printf "%-32s %12s\n", "CONTAINER", "MEDIANA_MiB"
  for (k = 1; k <= n; k++) {
    name = order[k]; c = cnt[name]
    for (i = 1; i <= c; i++) arr[i] = val[name, i]
    for (i = 1; i <= c; i++) for (j = i + 1; j <= c; j++) if (arr[j] < arr[i]) { t = arr[i]; arr[i] = arr[j]; arr[j] = t }
    med = (c % 2) ? arr[(c + 1) / 2] : (arr[c / 2] + arr[c / 2 + 1]) / 2
    printf "%-32s %12.2f\n", name, med
    total += med
  }
  printf "%-32s %12.2f\n", "TOTAL (soma das medianas)", total
  printf "amostras=%d containers=%d\n", samples, n
}' "$raw"
