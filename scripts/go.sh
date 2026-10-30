#!/usr/bin/env sh
# Usa o Go local quando existir (a diretiva `toolchain` do server/go.mod baixa a versão certa);
# sem Go instalado, cai para o container oficial na mesma versão. DOCKER_ARGS adiciona flags ao docker run.
set -e
cd "$(dirname "$0")/../server"
if command -v go >/dev/null 2>&1 && [ -z "${SPOOK_GO_DOCKER:-}" ] && [ -z "${DOCKER_ARGS:-}" ]; then
  exec go "$@"
fi
version="$(awk '/^toolchain /{sub(/^go/,"",$2); print $2}' go.mod)"
# shellcheck disable=SC2086
exec docker run --rm ${DOCKER_ARGS:-} -v "$PWD":/src -v spook-gomod:/go/pkg/mod -v spook-gobuild:/root/.cache/go-build \
  -w /src -e CGO_ENABLED=0 "golang:${version}-alpine" go "$@"
