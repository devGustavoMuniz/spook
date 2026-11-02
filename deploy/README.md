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
 livekit ─▶ http://spook:8090/api/livekit/webhook   (estado de voz; rede interna do Compose, assinado com a API key)
 spook ─▶ http://livekit:7880                       (API de administração: expulsar, listar, permissões)
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
| spook | 512M | 64M | 512 | 0.6 | meta ocioso <100M (RNF01); pico de 4 hashes Argon2id (4×19M) + GC; Fase 6: até 2 thumbnails ao mesmo tempo (imagem de até 12 MP ≈ 50M cada, entre original, decodificada e redimensionada) + 25 MB do original em memória; `GOMEMLIMIT=400MiB` |
| livekit | 512M | 64M | 512 | 0.5 | ocioso ~30M; folga para as primeiras chamadas (Fase 5) |
| garage | 256M | 64M | 512 | 0.2 | metadados em LMDB (page cache conta no cgroup); ocioso ~30M |
| cloudflared | 128M | 32M | 128 | 0.2 | ocioso ~25M |
| **soma** | **1920M** | 480M | **2176** | 2.0 | memória < 2500M (high) < 3G; pids < 3072 |

- **Memória e pids:** a soma dos limites (1920M, 2176) fica abaixo do slice, deixando ~580M e ~900 tarefas para o daemon e picos.
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

> **`admin.sh` não amplia a chave de CI.** O `deploy/admin.sh` e o subcomando `spook admin` **não** alteram o `ci-entry.sh`
> nem a chave de CI. O `ci-entry.sh` é instalado à mão (o deploy não o substitui) e continua aceitando só `receive-deploy`,
> `write-env` e `deploy <imagem> <usuário>`; qualquer outro comando, inclusive `admin.sh`, sai com **exit 126**. O `admin.sh`
> só roda por quem já tem shell no VPS (usuário administrativo com sudo), via
> `ssh <host administrador> "sudo -iu spook /srv/spook/prod/deploy/admin.sh ..."`; o host administrativo vem da config SSH
> do dono, não do repositório. Nenhum workflow (`ci.yml`, `deploy.yml`) chama o `admin.sh`.

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
| `VAPID_PUBLIC_KEY` | chave pública VAPID (base64url) do Web Push; `npx web-push generate-vapid-keys` |
| `VAPID_PRIVATE_KEY` | chave privada VAPID (par da anterior). Gere o par uma vez e não troque: as inscrições dos navegadores ficam presas à pública |
| `VAPID_SUBJECT` | contato do operador, sem espaços (`mailto:voce@dominio`) |
| `CLOUDFLARE_TUNNEL_TOKEN` | token de 1.4 |

**Variables** (opcionais; o padrão está entre parênteses):
`PUBLIC_URL` (`https://spook.dottadigital.com`), `GARAGE_CAPACITY` (`50GB`), `LIVEKIT_NODE_IP` (`187.127.26.46`),
`ADMIN_USERNAMES` (vazio; usernames separados por vírgula promovidos a administrador do painel `/admin` no boot do backend: cadastre a conta, defina a Variable e refaça o deploy; nunca rebaixa ninguém, para isso use `UPDATE users SET is_admin = false WHERE username = '...'`), `S3_ENDPOINT` (`https://spook-files.dottadigital.com`), `S3_CORS_ORIGINS` (`https://spook.dottadigital.com,tauri://localhost,http://tauri.localhost`: a web e o app desktop).

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

**Config do LiveKit renderizada (Fase 5).** O LiveKit precisa avisar o backend por webhook (`http://spook:8090/api/livekit/webhook`),
assinado com uma API key que tem de ser a `LIVEKIT_API_KEY` do `.env` do servidor (a chave não é segredo, mas o valor não está no git).
Por isso `deploy/livekit/livekit.prod.yaml.tmpl` (versionado, com o placeholder `__LIVEKIT_API_KEY__`) é renderizado pelo `deploy.sh`,
com `sed`, para `deploy/livekit/livekit.prod.yaml` (arquivo montado pelo compose; não versionado, ignorado pelo git). O hash
(`CONFIG_HASH`) é calculado **depois** da renderização, então trocar a `LIVEKIT_API_KEY` também recria o container. O deploy aborta se a
chave faltar no `.env` ou tiver caracteres fora de `[A-Za-z0-9_-]`. O serviço `spook` recebe `LIVEKIT_URL=wss://spook-rtc.dottadigital.com`
(a URL que o navegador usa), `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` (os mesmos do `.env`, escritos pelo `write-env` a partir dos secrets) e
`LIVEKIT_INTERNAL_URL=http://livekit:7880`. Sem essas variáveis a voz fica desligada (os endpoints respondem 503).

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

### 6.1.1b Painel administrativo `/admin` (adicional)
Quem é administrador: coluna `users.is_admin` (migration `00009_admin.sql`). Para promover contas no boot, defina a Variable
`ADMIN_USERNAMES` do GitHub (usernames separados por vírgula; o `write-env` a grava no `.env` e o compose a passa ao container
`spook`). A promoção é idempotente e roda a cada partida do backend; **a conta precisa existir antes** (cadastre-se, defina a
Variable e refaça o deploy, ou reinicie o `spook`). A `ADMIN_USERNAMES` nunca rebaixa ninguém. Para promover ou rebaixar direto no VPS, sem redeploy (vale na hora), use
`deploy/admin.sh` (o `receive-deploy` o instala junto do resto de `deploy/`):
```sh
ssh <vps> "sudo -iu spook /srv/spook/prod/deploy/admin.sh grant nyak"    # promove
ssh <vps> "sudo -iu spook /srv/spook/prod/deploy/admin.sh revoke nyak"   # rebaixa
ssh <vps> "sudo -iu spook /srv/spook/prod/deploy/admin.sh list"          # lista
```
(É o subcomando `spook admin grant|revoke|list` do binário, executado no contêiner `spook`.)
Sem a Variable ninguém é promovido e `/admin` responde 403 a todos.

**Como o acesso ao painel é controlado**
1. **Quem é admin:** só a coluna `users.is_admin`. Ela muda por `ADMIN_USERNAMES` (no boot, só promove), por `spook admin grant|revoke|list`
   (via `deploy/admin.sh`, por SSH) ou direto no banco. Não existe rota HTTP que promova alguém.
2. **Onde é checado:** no backend, em **cada** rota `/api/admin/**`: o middleware de sessão (cookie `spook_session` ou
   `Authorization: Bearer`) responde **401** sem sessão e, em seguida, o `requireAdmin` consulta `users.is_admin` **no banco a
   cada requisição** (sem cache) e responde **403** com corpo genérico ("acesso restrito a administradores") a quem não é admin.
   Rebaixar vale na hora, na mesma sessão. O cabeçalho `X-Spook-Client: desktop` sozinho não autentica nada, e um Bearer de usuário
   comum também recebe 403.
3. **"Tempo real":** o painel **não** usa stream, SSE nem WebSocket. É polling HTTP das mesmas rotas protegidas (`live`, `system` e
   `calls` a cada 5 s; `overview` a cada 30 s, com cache de servidor de igual duração). Nenhum dado de administração trafega pelo gateway
   WebSocket: o catálogo de eventos (`server/internal/platform/events`) e os ops do gateway não têm nada de admin.
4. **Web:** o guard de `/admin` no roteador e o link "Painel de administração" são só conveniência de UI; a verificação real é a do
   backend. O campo `is_admin` de `/users/@me` só afeta a UI (forjá-lo no cliente não abre nenhuma rota).
5. **Cobertura por construção:** `TestAdminEveryRouteIsGuarded` (`server/internal/app/admin_integration_test.go`) enumera as rotas
   `/api/admin/**` do OpenAPI gerado e exige, para todos os métodos, 401 sem sessão, 403 para usuário comum e 2xx para admin; uma rota
   nova sem o guard falha o CI. Outros testes cobrem Bearer/desktop, rebaixamento imediato e a ausência de dados de admin no gateway.

#### Camada extra: Cloudflare Access em `/admin` (opcional; **não configurada**)
O backend já protege tudo (acima). Se quiser uma segunda barreira antes mesmo de a requisição chegar ao app, decida e faça no painel
da Cloudflare (nada disto foi aplicado):
1. **Zero Trust → Access → Applications → Add an application → Self-hosted.**
2. Domínio `spook.dottadigital.com`, paths `admin*` (cobre `/admin` e `/admin/*`) **e** `api/admin*`. O web chama `/api/admin/**` no mesmo
   host; se só a página ficar protegida, a API continua alcançável (só pela proteção do backend). Com os dois paths na mesma
   application, o cookie `CF_Authorization` vai junto automaticamente nas chamadas do mesmo domínio. Teste no navegador: abra `/admin`,
   faça o login do Access e confirme que os gráficos carregam (uma API bloqueada aparece como erro de leitura no painel).
3. Política **Allow** só com o seu e-mail, método **One-time PIN** por e-mail. Defina a duração da sessão (ex.: 24 h).
4. Ressalvas: **não** crie política "Bypass" nem mexa na configuração global da zona (afeta outros sites; aplique só a esta
   application). O app desktop (Tauri) usa o mesmo host com Bearer: com `api/admin*` atrás do Access ele não alcança o admin
   (aceitável: admin só no navegador). O restante de `/api/**`, o gateway e `/` ficam fora e seguem iguais.
5. Para desligar: exclua a application no Zero Trust; nada no repositório precisa mudar.

O painel lê o Prometheus do LiveKit em `http://livekit:6789/metrics` (rede interna; `prometheus.port: 6789` em
`deploy/livekit/livekit.prod.yaml.tmpl`; **a porta não é publicada no host** e o Cloudflare Tunnel não a expõe). Mudar essa
config recria o `livekit` (hash da config). Outro endereço: `LIVEKIT_METRICS_URL` no `.env`. Sem o endpoint, o painel mostra
"indisponível" no bloco do LiveKit e o resto continua funcionando.

### 6.1.2 CORS da API e do storage para o app desktop (Fase 7a)
O webview do Tauri tem origem `tauri://localhost` (macOS/Linux) ou `http://tauri.localhost` (Windows), diferente de
`spook.dottadigital.com`; por isso a API passou a responder CORS **só** para as origens de `SPOOK_ALLOWED_ORIGINS` (a mesma
lista do handshake do gateway, padrão `tauri://localhost,http://tauri.localhost`, então não há nada a configurar em produção):
- Vale para `/api/*`. O preflight (`OPTIONS` com `Access-Control-Request-Method`) responde `204` **antes** do rate limit.
- Origem permitida recebe `Access-Control-Allow-Origin: <origem>`, `Vary: Origin`, `Allow-Methods`, `Allow-Headers`
  (`Authorization, Content-Type, X-Spook-Client`), `Max-Age` e `Expose-Headers` (`Retry-After, Server-Timing`), inclusive nas
  respostas de erro (401, 429). **Sem `Access-Control-Allow-Credentials`**: o desktop usa `Authorization: Bearer`, nunca cookie.
- Origem fora da lista (e a web same-origin) não recebe nenhum cabeçalho CORS. Lista vazia (`SPOOK_ALLOWED_ORIGINS=`) desliga o CORS.
- Teste: `curl -si -X OPTIONS https://spook.dottadigital.com/api/users/me -H 'Origin: tauri://localhost' -H 'Access-Control-Request-Method: GET'`
  deve dar `204` com `Access-Control-Allow-Origin: tauri://localhost`; com `-H 'Origin: https://outro.com'` não pode haver cabeçalho CORS.
- Storage: o bucket também só libera origens da lista `S3_CORS_ORIGINS`, agora com as do Tauri (upload de anexos/avatares e
  leitura das miniaturas direto do `spook-files`). Depois de mudar a lista, rode o deploy de novo (o `garage-init.sh` reaplica o CORS).

### 6.2 LiveKit
Sinalização: `curl -s https://spook-rtc.dottadigital.com` deve responder `OK`. Webhook (Fase 5): numa chamada, `docker compose ... logs livekit | grep webhook`
deve mostrar `sent webhook` com `"status": "200 OK"` para `http://spook:8090/api/livekit/webhook` (401 = chave/segredo diferentes entre `spook` e `livekit`;
`connection refused` = `spook` fora do ar) e o arquivo renderizado deve ter `webhook.api_key` igual à `LIVEKIT_API_KEY` do `.env`. Mídia (a partir da Fase 5): as portas
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
| **503 intermitente** em `/api/*` (ex.: `GET /api/guilds`, `POST /typing`) | O backend só devolve 503 para funcionalidade desligada (voz/push/uploads), shutdown ou `/healthz` degradado; nunca para esses endpoints e nunca por rate limit (que é 429 com `Retry-After`). **Respostas do backend sempre trazem `Server-Timing` e `X-Request-Id`**: um 503 SEM esses headers veio da borda (Cloudflare/cloudflared) com o container fora do ar, tipicamente durante um deploy (o `compose up` recria o `spook`: alguns segundos sem origem). Cada deploy bem-sucedido aparece em *Actions > Deploy*; compare o horário. Se o 503 TEM `X-Request-Id`, procure o id nos logs do container (`resposta 5xx` com método, caminho e duração). |
| Anexo falha com 500 e `HeadObject ... 403` nos logs | O backend falou com o storage pelo endpoint PÚBLICO (via Cloudflare). Operações do servidor usam `S3_INTERNAL_ENDPOINT` (`http://garage:3900` no compose); `S3_ENDPOINT` só assina URLs. Confira as duas variáveis. |
| Deploy sai com **126** | a chave de CI recusou o comando: nome inválido, imagem fora de `ghcr.io/<dono>/spook:<tag>` ou usuário do GHCR não alfanumérico (ver 1.3). |
| `ssh: ... Connection timed out` | o workflow já repete 5 vezes (5s, 10s, 20s, 40s); se persistir, o VPS/firewall está inacessível a partir do runner. |
| `write-env` falha | stdin vazio (um dos secrets obrigatórios está vazio) — o passo falha antes de enviar. |
| Container morto por memória (`OOMKilled`) | o serviço bateu o `mem_limit` (1.2); reveja a tabela antes de subir o limite. |
| Deploy falha em `Host key verification failed` | `SSH_KNOWN_HOSTS` desatualizado (VPS reinstalado): refaça o `ssh-keyscan`. |
| `docker login ghcr.io` negado | dar acesso de leitura do repositório ao pacote (item 4.3). |
| Push responde 503 | faltam `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT` no container `spook` (o push fica desligado sem as três; o log da partida avisa se só algumas foram definidas). |
| Voz responde 503 | faltam `LIVEKIT_URL`/`LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` no container `spook` (a voz fica desligada sem elas). |
| Chamada conecta mas a lista de quem está em voz não atualiza | o webhook não chega ao backend (6.2); o reconciliador (60 s) acaba corrigindo, mas confira os logs do `livekit`. |
| `/admin` responde 403 / o link não aparece | a conta não é administradora: confira `ADMIN_USERNAMES` (Variable do repositório, 2) e reinicie o `spook`; veja 6.1.1b. |
| "Uso do servidor LiveKit" aparece como indisponível | o Prometheus do LiveKit não responde em `http://livekit:6789/metrics`: confira `prometheus.port` no `livekit.prod.yaml` renderizado e os logs do `livekit`. |
| Workflow termina em "healthz não respondeu ok" | túnel sem os hostnames, token errado (`logs cloudflared`) ou `spook` não healthy (`logs spook`). |
| Upload do avatar: `SignatureDoesNotMatch` | o túnel está reescrevendo o Host (6.3), ou `S3_ENDPOINT` ≠ hostname público. |
| Upload do avatar: erro de CORS | `S3_CORS_ORIGINS` diferente da origem real; rode `deploy/deploy.sh` de novo (reaplica o CORS). |
| `bind: address already in use` em 7891/7892 | colisão com outro app: `ss -tulnp \| grep -E ':(7891\|7892)\b'` (o antrax usa 7881/7882). |
| Garage `NO ROLE ASSIGNED` persistente | `garage-init.sh` não rodou; rode de novo o deploy (ou, com acesso admin: `sudo -iu spook bash -c 'cd /srv/spook/prod && COMPOSE_FILE=deploy/docker-compose.prod.yml COMPOSE_ENV_FILE=.env sh deploy/garage-init.sh'`). |

### 6.4 Download do app e aviso de nova versão (adicional)
- **`/download`** (página pública do web) lê `https://api.github.com/repos/devGustavoMuniz/spook/releases/latest` direto do navegador
  (sem token; limite anônimo de 60 req/h por IP, com cache de 10 min no cliente). Enquanto não houver release **publicado**
  (rascunho não conta) a página mostra "Ainda não há versão publicada". Para publicar: passo a passo em `apps/desktop/README.md`
  ("Publicar uma versão"). Teste: abra `/download` e confira versão, tamanhos e SHA-256 de cada instalador.
- **Atualizador do app:** secrets `TAURI_SIGNING_PRIVATE_KEY` e `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` do repositório (criar com `gh secret set`, ver
  `apps/desktop/README.md`; guarde um backup da privada). O endpoint é o asset `latest.json` do release publicado mais recente. O CSP do app não muda
  (o download é feito pelo Rust, fora do webview).
- **Aviso de nova versão do web:** o build gera `/version.json` (`{ version, commit, builtAt }`), servido com
  `Cache-Control: no-cache` pelo próprio backend (a regra "todo o resto revalida" de `webui`). A imagem recebe o sha por
  `--build-arg SPOOK_COMMIT=${{ github.sha }}` (`deploy.yml`). Se a Cloudflare reescrever o cache de `.json` (como faz com `.js`,
  ver as Pendências gerais), o aviso demora a aparecer; crie uma regra de cache "Bypass" para `/version.json`.
  Teste: `curl -s https://spook.dottadigital.com/version.json` deve devolver o sha do deploy atual.

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
Smoke do `deploy.sh` com segredos falsos (sem `cloudflared`), simulando a raiz do servidor numa pasta temporária (o `.env` falso precisa de
`LIVEKIT_API_KEY` alfanumérico: o deploy renderiza o `livekit.prod.yaml` a partir dele). Para ver o webhook de ponta a ponta, depois do smoke rode um
participante simulado na rede do projeto e olhe os logs do livekit:
`docker run --rm --network spookprodsmoke_default -e LIVEKIT_URL=ws://livekit:7880 -e LIVEKIT_API_KEY=<chave> -e LIVEKIT_API_SECRET=<segredo> livekit/livekit-cli:latest load-test --room 12345 --duration 6s --audio-publishers 1 --subscribers 1`
e `docker logs spookprodsmoke-livekit-1 | grep webhook` (esperado: `200 OK`).
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
