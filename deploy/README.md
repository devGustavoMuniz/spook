# Deploy do Spook (VPS Hostinger, Docker rootless, Cloudflare Tunnel)

Mesmo padrão do antrax: um usuário Linux por app (`spook`), Docker **rootless**, ninguém em 80/443,
entrada por **Cloudflare Tunnel** (container `cloudflared` próprio). A mídia do LiveKit vai direto pelo
IP público. O deploy é feito por **GitHub Actions via SSH como `spook`** (sem root) e as imagens são
**buildadas no CI e publicadas no GHCR**: nada é buildado no VPS.

```
push na main ─▶ CI (ci.yml) ─▶ build/push GHCR ─▶ SSH como spook ─▶ deploy/deploy.sh ─▶ docker compose (rootless)
                                                                        │
 navegador ─▶ Cloudflare ─▶ túnel ─▶ cloudflared ─┬▶ spook:8090   (web + API + gateway)  spook.dottadigital.com
                                                  ├▶ livekit:7880 (sinalização)          spook-rtc.dottadigital.com
                                                  └▶ garage:3900  (S3, URLs pré-assinadas) spook-files.dottadigital.com
 navegador ─▶ 187.127.26.46:7891/tcp e :7892/udp ─▶ livekit      (mídia, direto; sem TURN)
```

> ✅ = pode ser validado sem o servidor. 🔒 = **só o dono consegue validar** (precisa do VPS, da Cloudflare ou do GitHub).

## 1. Preparação única (como root no VPS) 🔒

### 1.1 Usuário e Docker rootless
```sh
# dependências do Docker rootless (se o antrax já roda rootless, quase tudo já está instalado)
apt-get update && apt-get install -y uidmap dbus-user-session slirp4netns rsync curl
# docker-ce, docker-ce-cli, docker-compose-plugin e docker-ce-rootless-extras já devem existir (antrax);
# senão, instale-os pelo repositório oficial da Docker e DESABILITE o daemon do sistema para este usuário:
#   systemctl disable --now docker.service docker.socket   # só se ninguém mais usar o daemon root

useradd --create-home --shell /bin/bash spook
id spook                                   # anote o UID (o antrax é 1003; o do spook será outro)
grep '^spook:' /etc/subuid /etc/subgid     # precisa existir um intervalo para cada (ex.: spook:231072:65536)
# se faltar:  usermod --add-subuids 300000-365535 --add-subgids 300000-365535 spook
# (escolha um intervalo que NÃO se sobreponha ao do antrax: veja /etc/subuid)

loginctl enable-linger spook               # o daemon rootless sobe no boot e sobrevive ao logout do SSH
```

Instale o daemon rootless **como o próprio usuário** (use `machinectl` ou `su -` com sessão completa para
o `XDG_RUNTIME_DIR` existir):
```sh
machinectl shell spook@                    # ou: ssh spook@localhost depois de colocar uma chave
dockerd-rootless-setuptool.sh install
systemctl --user enable --now docker
cat >> ~/.profile <<'PROFILE'
export XDG_RUNTIME_DIR=/run/user/$(id -u)
export DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock
PROFILE
. ~/.profile && docker info --format '{{.SecurityOptions}}' && docker compose version
```
Esperado: `rootless` nas opções de segurança e o plugin `compose` respondendo.
O socket fica em `/run/user/<uid-do-spook>/docker.sock` (o `deploy.sh` calcula isso sozinho).

### 1.2 Chave SSH do deploy
Na **sua máquina** (ou em qualquer lugar seguro; a privada vai só para o GitHub):
```sh
ssh-keygen -t ed25519 -C "spook-deploy-github" -f spook_deploy -N ""
```
No VPS, em `/home/spook/.ssh/authorized_keys` (modo 600, dono `spook`), com restrições sensatas:
```
restrict,no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding ssh-ed25519 AAAA... spook-deploy-github
```
(`restrict` já nega tudo; o deploy só precisa executar comandos, então não há `command=` fixo.)
`SSH_KNOWN_HOSTS` (para o GitHub validar o servidor, sem `StrictHostKeyChecking=no`):
```sh
ssh-keyscan -t ed25519 <IP-ou-host-do-VPS>
```
Teste ✅/🔒: `ssh -i spook_deploy spook@<VPS> 'echo ok; docker ps'` deve imprimir `ok` e a lista (vazia) de containers.

### 1.3 Diretório de trabalho
```sh
sudo -u spook mkdir -p /home/spook/spook      # o workflow envia deploy/ e escreve o .env aqui
```

### 1.4 Túnel da Cloudflare 🔒
No painel **Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared**:
1. Nome: `spook`. **Copie o token** (vai para o secret `CLOUDFLARE_TUNNEL_TOKEN`). Não instale o conector no host: o conector é o container `cloudflared` do Compose.
2. Em **Public Hostnames**, crie (a Cloudflare cria os CNAMEs sozinha):

   | Hostname | Service |
   | --- | --- |
   | `spook.dottadigital.com` | `HTTP` → `spook:8090` |
   | `spook-rtc.dottadigital.com` | `HTTP` → `livekit:7880` |
   | `spook-files.dottadigital.com` | `HTTP` → `garage:3900` |

   Os nomes (`spook`, `livekit`, `garage`) são os serviços de `docker-compose.prod.yml`. Não ative HTTP/2-origin nem
   altere o "HTTP Host Header" (deixe vazio): o Garage precisa receber o `Host` público original para validar a
   assinatura das URLs pré-assinadas (ver 6.3).
3. Os três hostnames ficam em um nível só de subdomínio, cobertos pelo certificado gratuito da Cloudflare.
4. Upload de até 25 MB cabe no limite do plano free (100 MB por requisição).

### 1.5 Firewall 🔒
Libere **7891/tcp** e **7892/udp** (mídia do LiveKit) no firewall da Hostinger (painel do VPS → Firewall) e, se
houver, no `ufw`:
```sh
ufw allow 7891/tcp comment 'spook livekit rtc tcp'
ufw allow 7892/udp comment 'spook livekit rtc udp'
```
Não abra 80/443 nem 7880 (a sinalização só entra pelo túnel). Confirme que **não colidem com o antrax**:
```sh
ss -tulnp | grep -E ':(7891|7892)\b' || echo "livres"      # antes do primeiro deploy: deve imprimir "livres"
ss -tulnp | grep -E ':(7881|7882)\b'                         # portas do antrax, para referência
```

## 2. GitHub: Secrets e Variables 🔒

Em **Settings → Secrets and variables → Actions** (repositório). O workflow usa o *environment* `production`
(criado no primeiro uso; você pode, se quiser, exigir aprovação manual nele).

**Secrets** (todos obrigatórios; use só `[A-Za-z0-9]`, pois entram em URLs/arquivos):
| Secret | Valor |
| --- | --- |
| `SSH_HOST` | IP ou host do VPS |
| `SSH_USER` | `spook` |
| `SSH_PRIVATE_KEY` | conteúdo de `spook_deploy` (a privada de 1.2) |
| `SSH_KNOWN_HOSTS` | saída do `ssh-keyscan` de 1.2 |
| `POSTGRES_PASSWORD` | `openssl rand -hex 24` |
| `GARAGE_RPC_SECRET` | `openssl rand -hex 32` |
| `S3_ACCESS_KEY_ID` | `echo "GK$(openssl rand -hex 12)"` (formato do Garage: `GK` + 24 hex) |
| `S3_SECRET_ACCESS_KEY` | `openssl rand -hex 32` |
| `LIVEKIT_API_KEY` | ex.: `spook` |
| `LIVEKIT_API_SECRET` | `openssl rand -hex 32` |
| `CLOUDFLARE_TUNNEL_TOKEN` | token de 1.4 |

**Variables** (opcionais; o padrão está entre parênteses):
`PUBLIC_URL` (`https://spook.dottadigital.com`), `GARAGE_CAPACITY` (`50GB`), `LIVEKIT_NODE_IP` (`187.127.26.46`),
`S3_ENDPOINT` (`https://spook-files.dottadigital.com`), `S3_CORS_ORIGINS` (`https://spook.dottadigital.com`).

`GITHUB_TOKEN` (automático) publica a imagem e é usado só durante o deploy para o `docker login` no GHCR; o
`deploy.sh` faz `docker logout` ao terminar. Nada de PAT.

## 3. Como o deploy funciona

`.github/workflows/deploy.yml` roda em **push na `main`** e em **workflow_dispatch**:
1. `ci` — reutiliza `ci.yml` (lint, testes, drift de OpenAPI/sqlc/orval, integração com Postgres+Garage).
2. `build` — `deploy/Dockerfile` → `ghcr.io/<dono-em-minúsculas>/spook:<sha-completo>` e `:latest` (linux/amd64).
3. `deploy` — por SSH como `spook`:
   - envia `deploy/` para `~/spook/deploy` (`tar` por SSH);
   - escreve `~/spook/.env` a partir dos secrets, com `umask 077` (modo 600), preservando a linha `SPOOK_IMAGE`;
   - roda `deploy/deploy.sh <imagem>`: login no GHCR (token pelo stdin), grava `SPOOK_IMAGE`, `compose pull`,
     sobe `postgres` e `garage`, roda `garage-init.sh` (layout, bucket, chave e CORS — idempotente),
     `compose up -d`, espera o healthcheck do `spook` e confirma `/healthz`;
   - o workflow então consulta `https://spook.dottadigital.com/healthz` pela internet (falha se não responder `{"status":"ok"}`).
4. `concurrency: deploy-production` impede dois deploys simultâneos.

Segredos nunca entram no git: só existem nos GitHub Secrets e no `~/spook/.env` do servidor (600).
`deploy/.env.prod.example` documenta as chaves sem valores.

## 4. Primeiro deploy 🔒
1. Complete as seções 1 e 2 (usuário, Docker rootless, chave, túnel com os 3 hostnames, firewall, secrets).
2. **Actions → Deploy → Run workflow** (branch `main`). O push na `main` também dispara.
3. No GitHub: o pacote `spook` aparece em *Packages* (vinculado ao repositório; se o `docker login` falhar por
   permissão, abra o pacote → *Package settings* → *Manage Actions access* e dê acesso de leitura ao repositório).
4. Verifique:
   ```sh
   curl -s https://spook.dottadigital.com/healthz            # {"status":"ok"}
   ssh spook@<VPS> 'cd ~/spook && docker compose --env-file .env -f deploy/docker-compose.prod.yml ps'
   ```
   Todos `healthy`/`running`; `cloudflared` conectado (`docker compose ... logs cloudflared` mostra "Registered tunnel connection").

## 5. Rollback 🔒
Cada deploy registra a imagem anterior em `~/spook/.image-history`. Para voltar:
- **Actions → Deploy → Run workflow**, campo `image_tag` = o sha anterior (a tag, sem `ghcr.io/...`). Isso pula CI e build e
  só reimplanta aquela tag (as imagens ficam no GHCR). Ou, direto no servidor:
  ```sh
  ssh spook@<VPS> 'cd ~/spook && cat .image-history && deploy/deploy.sh ghcr.io/<dono>/spook:<sha-anterior>'
  ```
  (sem o token do GHCR no stdin o login é pulado; funciona se a imagem já estiver no cache local do daemon.)
- As migrations rodam no boot e são só para frente: um rollback de imagem **não** desfaz migrations. Mantenha migrations
  compatíveis com a versão anterior (expandir antes de contrair).

## 6. Verificações específicas 🔒

### 6.1 Túnel e web
`https://spook.dottadigital.com/` abre o app; `/healthz` responde `ok`; `/api/openapi.yaml` responde.
O backend usa `CF-Connecting-IP` (`SPOOK_REAL_IP_HEADER`) para o rate limit por IP: confirme que **não** é o IP do
cloudflared, repetindo 12 logins errados seguidos de uma máquina e vendo o `429`, enquanto outra rede continua OK.

### 6.2 LiveKit
Sinalização: `curl -s https://spook-rtc.dottadigital.com` deve responder `OK`. Mídia (a partir da Fase 5): as portas
`7891/tcp` e `7892/udp` precisam estar alcançáveis em `187.127.26.46`:
```sh
nc -vz 187.127.26.46 7891          # de fora do VPS
# UDP: confirme com o teste de carga/cliente da Fase 5; `ss -ulnp | grep 7892` no VPS mostra o listener do rootlesskit
```

### 6.3 Garage por trás do túnel (Host intacto)
As URLs pré-assinadas são assinadas para o host **público** (`spook-files.dottadigital.com`) e o Garage valida o
`Host` recebido. Se o túnel reescrevesse o Host, toda URL falharia com `SignatureDoesNotMatch`. Teste (do seu computador,
com as chaves do `.env` do servidor):
```sh
docker run --rm -e AWS_ACCESS_KEY_ID=<S3_ACCESS_KEY_ID> -e AWS_SECRET_ACCESS_KEY=<S3_SECRET_ACCESS_KEY> \
  -e AWS_DEFAULT_REGION=garage amazon/aws-cli:2.39.3 \
  --endpoint-url https://spook-files.dottadigital.com s3api list-objects-v2 --bucket spook
```
Resposta JSON (ou vazia) = assinatura aceita. Depois, na tela de perfil, envie um avatar: o PUT vai direto para
`spook-files` (confira no DevTools que não há erro de CORS; a origem liberada é `https://spook.dottadigital.com`).

## 7. Troubleshooting
| Sintoma | Causa provável / ação |
| --- | --- |
| `Cannot connect to the Docker daemon` no SSH | `loginctl enable-linger spook` não foi feito, ou `systemctl --user status docker` parado. O `deploy.sh` usa `/run/user/$(id -u)/docker.sock`. |
| `permission denied` / `newuidmap` ao subir containers | `uidmap` ausente ou `/etc/subuid`/`subgid` sem intervalo para `spook`. |
| Deploy falha em `Host key verification failed` | `SSH_KNOWN_HOSTS` desatualizado (VPS reinstalado): refaça o `ssh-keyscan`. |
| `docker login ghcr.io` negado | dar acesso de leitura do repositório ao pacote (item 4.3). |
| Workflow termina em "healthz não respondeu ok" | túnel sem os hostnames, token errado (`logs cloudflared`) ou `spook` não healthy (`logs spook`). |
| Upload do avatar: `SignatureDoesNotMatch` | o túnel está reescrevendo o Host (6.3), ou `S3_ENDPOINT` ≠ hostname público. |
| Upload do avatar: erro de CORS | `S3_CORS_ORIGINS` diferente da origem real; rode `deploy/deploy.sh` de novo (reaplica o CORS). |
| `bind: address already in use` em 7891/7892 | colisão com outro app; veja 1.5. |
| Garage `NO ROLE ASSIGNED` persistente | `garage-init.sh` não rodou; execute `cd ~/spook && COMPOSE_FILE=deploy/docker-compose.prod.yml COMPOSE_ENV_FILE=.env sh deploy/garage-init.sh`. |

## 8. Pendências conhecidas
- **Observabilidade em produção** (RNF02): `SPOOK_OTLP_ENDPOINT` está vazio, ou seja, sem traces em prod. Falta subir
  OTel Collector + Tempo/Prometheus/Loki/Grafana no VPS (ou enviar para um backend externo). Em dev tudo funciona (`pnpm dev`).
- **Backup** do Postgres e do Garage (SPEC, questão em aberto 3): não há rotina; os dados vivem em volumes do Docker rootless
  em `~spook/.local/share/docker/volumes`.
- **TURN/TLS** do LiveKit: fora do escopo por enquanto (se precisar, usar UDP em porta livre).
- Imagens de terceiros estão fixadas por tag (`garage v2.5.0`, `livekit v1.13.11`, `cloudflared 2026.10.7`,
  `postgres:17-alpine`); atualize de propósito.

## 9. Validação local (sem o VPS) ✅
```sh
docker build -f deploy/Dockerfile -t spook:local .                  # imagem de produção
docker compose --env-file deploy/.env.prod.example -f deploy/docker-compose.prod.yml config -q   # falha se faltar segredo
docker run --rm -v "$PWD":/mnt koalaman/shellcheck-alpine:stable shellcheck -x /mnt/deploy/deploy.sh /mnt/deploy/garage-init.sh
docker run --rm -v "$PWD":/repo -w /repo rhysd/actionlint:latest
```
Smoke do compose de produção com segredos falsos (sem `cloudflared`): `COMPOSE_PROJECT_NAME=spookprodsmoke
DEPLOY_SERVICES="spook postgres garage livekit" DEPLOY_PULL_FLAGS=--ignore-pull-failures deploy/deploy.sh spook:local`
(ganchos de teste do `deploy.sh`; em produção ficam vazios).
