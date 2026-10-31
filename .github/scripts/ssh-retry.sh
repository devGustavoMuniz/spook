#!/usr/bin/env bash
# Executa `ssh vps <comando forçado>` com stdin vindo de um arquivo, repetindo quando a CONEXÃO falha
# (ssh sai com 255: "Connection timed out", reset etc. — comum nos runners do GitHub).
# Erros do comando remoto (qualquer outro código, inclusive 126 = comando recusado pelo ci-entry.sh)
# NÃO são repetidos. O stdin é um arquivo para poder ser relido a cada tentativa.
#
# Uso: ssh-retry.sh <arquivo-stdin|/dev/null> <comando remoto, ex.: "deploy IMAGEM USUARIO">
set -uo pipefail

stdin_file="${1:?uso: ssh-retry.sh <arquivo-stdin> <comando-remoto>}"
remote_cmd="${2:?uso: ssh-retry.sh <arquivo-stdin> <comando-remoto>}"
max="${SSH_RETRY_MAX:-5}"
delay="${SSH_RETRY_DELAY:-5}"

attempt=1
while :; do
  # shellcheck disable=SC2029  # o comando remoto é expandido no cliente de propósito (validado pelo chamador)
  ssh vps "$remote_cmd" < "$stdin_file"
  code=$?
  if [ "$code" -ne 255 ]; then exit "$code"; fi
  if [ "$attempt" -ge "$max" ]; then
    echo "ssh: falha de conexão após $max tentativas" >&2
    exit 255
  fi
  echo "ssh: falha de conexão (tentativa $attempt/$max); nova tentativa em ${delay}s" >&2
  sleep "$delay"
  attempt=$((attempt + 1))
  delay=$((delay * 2))
done
