#!/usr/bin/env bash
# Lista, para o daemon Docker do usuário atual, as redes e os containers com seus IPs e portas expostas.
# Serve para achar a rede e o endereço interno de um app (ex.: o do antrax) antes de rodar run-internal.sh.
# Executa NO VPS como o dono do Docker rootless:
#   ssh gustavo@<vps> "sudo -iu antrax bash -s" < bench/scripts/vps-discover.sh
#   ssh gustavo@<vps> "sudo -iu spook  bash -s" < bench/scripts/vps-discover.sh
set -euo pipefail

uid="$(id -u)"
if [ -z "${DOCKER_HOST:-}" ] && [ -S "/run/user/$uid/docker.sock" ]; then
  DOCKER_HOST="unix:///run/user/$uid/docker.sock"
  export DOCKER_HOST
fi

echo "== usuário: $(id -un) (uid $uid)  DOCKER_HOST=${DOCKER_HOST:-<padrão>}"
echo
echo "== redes"
docker network ls --format 'table {{.Name}}\t{{.Driver}}'
echo
echo "== containers: nome | imagem | rede=IP | portas expostas na imagem | publicadas no host"
for id in $(docker ps -q); do
  docker inspect "$id" --format \
    '{{.Name}} | {{.Config.Image}} | {{range $n, $v := .NetworkSettings.Networks}}{{$n}}={{$v.IPAddress}} {{end}}| exposta: {{range $p, $_ := .Config.ExposedPorts}}{{$p}} {{end}}| host: {{range $p, $b := .NetworkSettings.Ports}}{{if $b}}{{$p}}->{{(index $b 0).HostPort}} {{end}}{{end}}'
done | sed 's#^/##'
cat <<'TXT'

Como escolher o alvo interno: use a MESMA origem que o túnel da Cloudflare usa para o hostname público
(Zero Trust > Networks > Tunnels > <túnel> > Public Hostnames > "Service"). Para o Spook é http://spook:8090.
Para o antrax, pegue o Service do hostname antrax.dottadigital.com; se for um proxy por virtual host, passe também
ANTRAX_HOST_HEADER=antrax.dottadigital.com (ver bench/README.md).
TXT
