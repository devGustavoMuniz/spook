#!/usr/bin/env bash
# Tamanho dos chunks JS/CSS do build do web (bruto e gzip). Uso: scripts/bundle-size.sh [dist]
set -euo pipefail
dist="${1:-apps/web/dist}/assets"
printf "%-48s %12s %12s\n" arquivo bruto gzip
tb=0; tg=0
for f in "$dist"/*.js "$dist"/*.css; do
  b=$(wc -c <"$f"); g=$(gzip -9 -c "$f" | wc -c)
  printf "%-48s %12d %12d\n" "$(basename "$f")" "$b" "$g"
  tb=$((tb+b)); tg=$((tg+g))
done
printf "%-48s %12d %12d\n" TOTAL "$tb" "$tg"
