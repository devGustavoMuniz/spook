# Deploy do Spook (VPS Hostinger, Docker rootless, Cloudflare Tunnel)

Mesmo padrão dos outros apps do VPS: um usuário Linux por app (`spook`, uid 1004), Docker **rootless**, ninguém em
80/443, entrada por **Cloudflare Tunnel** (container `cloudflared` próprio). A mídia do LiveKit vai direto pelo IP
público. O deploy roda no **GitHub Actions** e entra no servidor por uma chave de CI com **comando forçado**; as imagens
são **buildadas no CI e publicadas no GHCR**: nada é buildado no VPS, sem `sudo`, sem `curl | sh`.

```
push na main ─▶ CI (ci.yml) ─▶ build/push GHCR ─▶ ssh (chave de CI) ─▶ ci-entry.sh ─▶ deploy/deploy.sh ─▶ docker compose
                                                                         │ receive-deploy | write-env | deploy
 navegador ─▶ Cloudflare ─▶ túnel ─▶ cloudflared ─┬▶ spook:8090   (web + API + gateway)  spook.dottadigital.com
                                                  ├▶ livekit:7880 (sinalização)          spook-rtc.dottadigital.com
                                                  └▶ garage:3900  (S3, URLs pré-assinadas) spook-files.dottadigital.com
 navegador ─▶ 187.127.26.46:7891/tcp e :7892/udp ─▶ livekit      (mídia, direto; sem TURN)
```

> ✅ = pode ser validado sem o servidor. 🔒 = **só o dono consegue validar** (precisa do VPS, da Cloudflare ou do GitHub).

## 1. O servidor

A preparação do VPS (usuário, Docker rootless, linger, diretórios, chave de CI e o `ci-entry.sh`) **não é feita aqui**:
é responsabilidade do `infra/project-setup.sh`, no repositório de infra. Este repositório só assume o resultado abaixo.

| Item | Valor |
| --- | --- |
| Usuário | `spook` (uid 1004) |
| Raiz do app | `/srv/spook/prod` (nada de `~/spook`); o `deploy.sh` resolve a partir de `deploy/..` |
| Docker | rootless próprio, socket `/run/user/1004/docker.sock`, runtime `runc-rootless` (`mem_limit`/`cpus` funcionam) |
| Portas publicadas | **só** `7891/tcp` e `7892/udp` (LiveKit). O resto entra pelo túnel |
| Slice do usuário | 3G de memória (high 2500M), 1 CPU, 3072 tarefas |

### 1.1 Layout em `/srv/spook/prod`
```
/srv/spook/prod/
├─ .env              # 600; escrito por `write-env` (segredos vêm dos GitHub Secrets); SPOOK_IMAGE é mantida pelo deploy
├─ .image-history    # imagens anteriores, uma por linha (rollback)
└─ deploy/           # substituído de forma atômica por `receive-deploy` (compose, scripts, configs)
```
O `deploy.sh` faz `cd "$(dirname "$0")/.."`, então tudo resolve a partir dessa pasta. Os **dados** ficam em volumes
nomeados do Docker rootless (`postgres-data`, `garage-meta`, `garage-data`), não em bind mounts: em rootless um bind mount
deixaria arquivos com subuids que o usuário `spook` não lê.

### 1.2 Limites por serviço (`docker-compose.prod.yml`)
O dockerd, o containerd e o rootlesskit rodam **dentro** do mesmo slice (~200M), então a soma dos limites tem folga.

| Serviço | `mem_limit` | reserva | `pids_limit` | `cpus` (teto) | Justificativa |
| --- | --- | --- | --- | --- | --- |
| postgres | 512M | 256M | 512 | 0.5 | `shared_buffers=128MB`, `max_connections=50`; maior consumidor real |
| spook | 384M | 64M | 512 | 0.6 | meta ocioso <100M (RNF01); pico de 4 hashes Argon2id (4×19M) + GC; `GOMEMLIMIT=300MiB` |
| livekit | 512M | 64M | 512 | 0.5 | ocioso ~30M; folga para as primeiras chamadas (Fase 5) |
| garage | 256M | 64M | 512 | 0.2 | metadados em LMDB (page cache conta no cgroup); ocioso ~30M |
| cloudflared | 128M | 32M | 128 | 0.2 | ocioso ~25M |
| **soma** | **1792M** | 480M | **2176** | 2.0 | memória < 2500M (high) < 3G; pids < 3072 |

- **Memória e pids:** a soma dos limites (1792M, 2176) fica abaixo do slice, deixando ~700M e ~900 tarefas para o daemon e picos.
- **CPU:** os tetos se sobrepõem de propósito (soma 2.0 > 1 CPU). O slice arbitra o total; assim um serviço usa a CPU que os
  outros não estão usando. Somar 1.0 estrangularia o backend com o resto ocioso e distorceria os benchmarks.
- Ao subir um limite, mantenha a soma de memória abaixo de 2500M; mexa nesta tabela e no cabeçalho do compose juntos.

### 1.3 A chave de CI e o comando forçado
A chave do GitHub Actions só executa o `ci-entry.sh` (comando forçado no `authorized_keys`). Não há shell, `scp`,
`sftp` nem forwarding. Qualquer comando fora da lista sai com **exit 126**.

| Comando | stdin | O que faz |
| --- | --- | --- |
| `receive-deploy` | `tar.gz` da pasta `deploy/` (sem caminhos absolutos nem `..`) | substitui `/srv/spook/prod/deploy` de forma atômica e faz `chmod +x` nos `*.sh` |
| `write-env` | conteúdo do `.env` (stdin vazio = erro) | grava `/srv/spook/prod/.env` (600), **preservando a linha `SPOOK_IMAGE=`** |
| `deploy <imagem> <usuário-ghcr>` | token do GHCR (pode ser vazio, p.ex. rollback) | roda `deploy/deploy.sh <imagem>` com `GHCR_USER` no ambiente |

Regras do `deploy`: a imagem deve casar `^ghcr\.io/[a-z0-9][a-z0-9._-]*/spook:[A-Za-z0-9._-]+$` e o usuário do GHCR deve ser
alfanumérico (o workflow valida os dois antes e falha com mensagem clara, em vez de um 126 no servidor).

Consequência prática: **o CI não consegue inspecionar o servidor** (`docker ps`, logs). Diagnóstico exige o seu acesso
administrativo ao VPS (ex.: `sudo -iu spook`).

### 1.4 Túnel da Cloudflare 🔒
Se o túnel ainda não existir, no painel **Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared**:
1. Nome: `spook`. **Copie o token** (vai para o secret `CLOUDFLARE_TUNNEL_TOKEN`). Não instale o conector no host: o conector é o container `cloudflared` do Compose.
2. Em **Public Hostnames**, crie (a Cloudflare cria os CNAMEs sozinha):

   | Hostname | Service |
   | --- | --- |
   | `spook.dottadigital.com` | `HTTP` → `spook:8090` |
   | `spook-rtc.dottadigital.com` | `HTTP` → `livekit:7880` |
   | `spook-files.dottadigital.com` | `HTTP` → `garage:3900` |

   Os nomes (`spook`, `livekit`, `garage`) são os serviços de `docker-compose.prod.yml`. Não altere o "HTTP Host Header"
   (deixe vazio): o Garage precisa receber o `Host` público original para validar a assinatura das URLs pré-assinadas (ver 6.3).
3. Os três hostnames ficam em um nível só de subdomínio, cobertos pelo certificado gratuito da Cloudflare.
4. Upload de até 25 MB cabe no limite do plano free (100 MB por requisição).

## 2. GitHub: Secrets e Variables 🔒

Em **Settings → Secrets and variables → Actions** (repositório). O workflow usa o *environment* `production`
(criado no primeiro uso; você pode, se quiser, exigir aprovação manual nele).

**Secrets** (todos obrigatórios; use só `[A-Za-z0-9]` nos segredos gerados, pois entram em URLs/arquivos):
| Secret | Valor |
| --- | --- |
| `SSH_HOST` | IP ou host do VPS |
| `SSH_USER` | `spook` |
| `SSH_PRIVATE_KEY` | a chave privada de CI cuja pública a infra autorizou com o comando forçado |
| `SSH_KNOWN_HOSTS` | saída de `ssh-keyscan -t ed25519 <SSH_HOST>` (confira o fingerprint) |
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

`GITHUB_TOKEN` (automático) publica a imagem e segue pelo stdin do comando `deploy` para o `docker login` no GHCR; o
`deploy.sh` faz `docker logout` ao terminar. Nada de PAT.

## 3. Como o deploy funciona

`.github/workflows/deploy.yml` roda em **push na `main`** e em **workflow_dispatch**:
1. `ci` — reutiliza `ci.yml` (lint, testes, drift de OpenAPI/sqlc/orval, integração com Postgres+Garage).
2. `build` — `deploy/Dockerfile` → `ghcr.io/<dono-em-minúsculas>/spook:<sha-completo>` e `:latest` (linux/amd64).
3. `deploy` — por SSH (chave de CI), três chamadas, cada uma com **retry automático** quando a conexão falha
   (`Connection timed out` etc., ssh sai com 255; ver `.github/scripts/ssh-retry.sh`; erros do comando remoto não são repetidos):
   - `tar -C deploy -cz . | ssh vps receive-deploy`
   - `ssh vps write-env < env` (o `.env` é montado a partir dos secrets com `umask 077` e apagado do runner no fim)
   - `printf %s "$GHCR_TOKEN" | ssh vps "deploy $IMAGE $GHCR_USER"`, que executa `deploy/deploy.sh <imagem>`:
     login no GHCR (usuário de `GHCR_USER`, token do stdin), grava `SPOOK_IMAGE` (e a anterior em `.image-history`),
     `compose pull`, sobe `postgres` e `garage`, roda `garage-init.sh` (layout, bucket, chave e CORS — idempotente),
     `compose up -d`, **espera todos os serviços com healthcheck** e confirma `/healthz`;
   - o workflow então consulta `https://spook.dottadigital.com/healthz` pela internet (falha se não responder `{"status":"ok"}`).
4. `concurrency: deploy-production` impede dois deploys simultâneos.

O `receive-deploy` troca `deploy/` por um diretório novo; um container com arquivo montado (`garage.toml`,
`livekit.prod.yaml`) continuaria com o arquivo antigo. Por isso o `deploy.sh` calcula um hash dessas configs
(`CONFIG_HASH`), usado como label dos dois serviços: se a config muda, o Compose recria o container.

Segredos nunca entram no git: só existem nos GitHub Secrets e no `/srv/spook/prod/.env` do servidor (600).
`deploy/.env.prod.example` documenta as chaves sem valores. Migrations rodam no boot do backend e são **aditivas**.

## 4. Primeiro deploy 🔒
1. Garanta que a infra já rodou o `project-setup.sh` para o `spook`, que o túnel tem os 3 hostnames (1.4) e que os
   secrets (2) estão cadastrados.
2. **Actions → Deploy → Run workflow** (branch `main`). O push na `main` também dispara.
3. No GitHub: o pacote `spook` aparece em *Packages* (vinculado ao repositório; se o `docker login` falhar por
   permissão, abra o pacote → *Package settings* → *Manage Actions access* e dê acesso de leitura ao repositório).
4. Verifique (com o seu acesso administrativo ao VPS, não com a chave de CI):
   ```sh
   curl -s https://spook.dottadigital.com/healthz            # {"status":"ok"}
   sudo -iu spook bash -c 'cd /srv/spook/prod && docker compose --env-file .env -f deploy/docker-compose.prod.yml ps'
   ```
   Todos `healthy`/`running`; `cloudflared` conectado (`... logs cloudflared` mostra "Registered tunnel connection").

## 5. Rollback 🔒
Cada deploy registra a imagem anterior em `/srv/spook/prod/.image-history`. Para voltar:
**Actions → Deploy → Run workflow**, campo `image_tag` = o sha anterior (a tag, sem `ghcr.io/...`). Isso pula CI e build e
chama `deploy <imagem> <usuário>` com o **mesmo token do GHCR** do deploy normal, então o `pull` não depende do cache do
servidor. (O `deploy.sh` ainda aceita stdin vazio, que só pula o login; o workflow sempre envia o token.)
- As migrations rodam no boot e são só para frente: um rollback de imagem **não** desfaz migrations. Mantenha migrations
  compatíveis com a versão anterior (expandir antes de contrair).

## 6. Verificações específicas 🔒

### 6.1 Túnel e web
`https://spook.dottadigital.com/` abre o app; `/healthz` responde `ok`; `/api/openapi.yaml` responde.
O backend usa `CF-Connecting-IP` (`SPOOK_REAL_IP_HEADER`) para o rate limit por IP: confirme que **não** é o IP do
cloudflared, repetindo 12 logins errados seguidos de uma máquina e vendo o `429`, enquanto outra rede continua OK.

### 6.1.1 Gateway WebSocket (Fase 3)
`GET /api/gateway` faz upgrade para WebSocket pelo mesmo túnel (o Cloudflare aceita WebSocket sem configuração e derruba
conexões **sem tráfego por 100 s**: o servidor manda heartbeat a cada 41 s). Variável nova: `SPOOK_ALLOWED_ORIGINS`
(origens extras aceitas no handshake, separadas por vírgula; padrão `tauri://localhost,http://tauri.localhost`, as do app desktop;
o próprio host `spook.dottadigital.com` é sempre aceito). O padrão serve à produção, então ela **não** está no
`docker-compose.prod.yml`; defina-a no `.env` só se precisar de outra origem. Handshake limitado a 50/s por IP (rajada de 200).
Teste: `websocat -H "Cookie: spook_session=<token>" wss://spook.dottadigital.com/api/gateway` deve mostrar o `{"op":10,...}` (HELLO).

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
| `Cannot connect to the Docker daemon` no deploy | Docker rootless do `spook` parado ou sem linger (infra). O `deploy.sh` usa `/run/user/1004/docker.sock`. Com acesso admin: `sudo -iu spook systemctl --user status docker`. |
| Deploy sai com **126** | a chave de CI recusou o comando: nome inválido, imagem fora de `ghcr.io/<dono>/spook:<tag>` ou usuário do GHCR não alfanumérico (ver 1.3). |
| `ssh: ... Connection timed out` | o workflow já repete 5 vezes (5s, 10s, 20s, 40s); se persistir, o VPS/firewall está inacessível a partir do runner. |
| `write-env` falha | stdin vazio (um dos secrets obrigatórios está vazio) — o passo falha antes de enviar. |
| Container morto por memória (`OOMKilled`) | o serviço bateu o `mem_limit` (1.2); reveja a tabela antes de subir o limite. |
| Deploy falha em `Host key verification failed` | `SSH_KNOWN_HOSTS` desatualizado (VPS reinstalado): refaça o `ssh-keyscan`. |
| `docker login ghcr.io` negado | dar acesso de leitura do repositório ao pacote (item 4.3). |
| Workflow termina em "healthz não respondeu ok" | túnel sem os hostnames, token errado (`logs cloudflared`) ou `spook` não healthy (`logs spook`). |
| Upload do avatar: `SignatureDoesNotMatch` | o túnel está reescrevendo o Host (6.3), ou `S3_ENDPOINT` ≠ hostname público. |
| Upload do avatar: erro de CORS | `S3_CORS_ORIGINS` diferente da origem real; rode `deploy/deploy.sh` de novo (reaplica o CORS). |
| `bind: address already in use` em 7891/7892 | colisão com outro app: `ss -tulnp \| grep -E ':(7891\|7892)\b'` (o antrax usa 7881/7882). |
| Garage `NO ROLE ASSIGNED` persistente | `garage-init.sh` não rodou; rode de novo o deploy (ou, com acesso admin: `sudo -iu spook bash -c 'cd /srv/spook/prod && COMPOSE_FILE=deploy/docker-compose.prod.yml COMPOSE_ENV_FILE=.env sh deploy/garage-init.sh'`). |

## 8. Pendências conhecidas
- **Observabilidade em produção** (RNF02): `SPOOK_OTLP_ENDPOINT` está vazio, ou seja, sem traces em prod. Plano e critério
  na Fase B do SPEC (Benchmarks e observabilidade): Grafana Cloud (plano gratuito) com só um coletor OpenTelemetry leve no VPS (e, então,
  o limite de memória dele entra na tabela 1.2). Em dev tudo funciona (`pnpm dev`).
- **Backup** (SPEC, questão em aberto 3): não há rotina ainda. O do Postgres será por `pg_dump`; os dados vivem em
  volumes nomeados do Docker rootless (`postgres-data`, `garage-meta`, `garage-data`). Estratégia do Garage: a definir.
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
Smoke do `deploy.sh` com segredos falsos (sem `cloudflared`), simulando a raiz do servidor numa pasta temporária:
```sh
R=$(mktemp -d); mkdir "$R/deploy"; tar -C deploy -cz . | tar -xz -C "$R/deploy"
cp deploy/.env.prod.example "$R/.env"        # preencha com valores falsos; LIVEKIT_NODE_IP=127.0.0.1
export DOCKER_HOST="$(docker context inspect -f '{{.Endpoints.docker.Host}}')"   # o script assume o socket rootless do Linux
cd "$R" && COMPOSE_PROJECT_NAME=spookprodsmoke DEPLOY_SERVICES="spook postgres garage livekit" \
  DEPLOY_PULL_FLAGS=--ignore-pull-failures deploy/deploy.sh spook:local < /dev/null
# limpar: docker compose --env-file .env -f deploy/docker-compose.prod.yml down -v   (e apagar $R)
```
(`DEPLOY_SERVICES` e `DEPLOY_PULL_FLAGS` são ganchos de teste; em produção ficam vazios.) O `retry` do SSH tem teste
próprio com um `ssh` falso (`.github/scripts/ssh-retry.sh`): repete só no código 255 e relê o stdin a cada tentativa.
