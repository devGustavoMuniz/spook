# Benchmarks

Cenários k6 reproduzíveis (RNF03). O mesmo cenário roda contra o Laravel (baseline, `antrax.dottadigital.com`)
e o Spook. **A partir da Fase 1 as medições são feitas contra produção no VPS** (SPEC, seção 8), e cada
resultado é registrado em **dois tipos de medição, lado a lado**, em `results/`:

| Tipo | O que mede | Onde roda | Caminho da requisição |
| --- | --- | --- | --- |
| **Internet** ("experiência do usuário") | o que o usuário final sente | seu computador | k6 → internet → Cloudflare → túnel → app |
| **Interno** ("backend") | só o app, sem o ruído da rede | no VPS, na rede Docker do app | k6 → app (rede Docker local; sem Cloudflare, túnel nem TLS) |

A diferença entre os dois é o custo de rede. O Spook ainda devolve o header **`Server-Timing`** com o tempo de
processamento da requisição (`app`) e do hash de senha (`argon2`), o que dá uma terceira visão do mesmo número
(o k6 grava como `server_timing_app` e `server_timing_argon2`). O antrax não tem esse header: para ele vale a
medição interna do k6.

> O `Server-Timing` e o login a 4/min só existem em produção depois do deploy do commit que os introduziu. Rode as
> medições novas depois de um deploy.

## 1. Cenários (`scenarios/`)

| Cenário | Alvo | Mede | Comparado entre os dois? |
| --- | --- | --- | --- |
| `baseline.js` | `HEALTH_PATH` (`/up` no antrax, `/healthz` no Spook) | latência do health check | sim |
| `me.js` | Spook `GET /api/users/me`; antrax `GET /settings/profile` | endpoint autenticado leve: o usuário logado, sem efeitos colaterais | **sim** (é o cenário comparável de aplicação) |
| `login.js` | só o Spook | `POST /api/auth/login` (cadastra 1 usuário de teste por execução) | **não** (ver abaixo) |

Todos usam carga leve (é produção). Variáveis comuns: `BASE_URL` (obrigatória), `RATE`/`DURATION` (padrão 5 req/s por 60 s),
`HOST_HEADER` e `FORWARDED_PROTO` (medição interna do antrax por trás de um proxy por virtual host). O `login.js` usa
`RATE_PER_MIN`/`DURATION` (padrão 4/min por 6 min).

### `me.js`: o endpoint autenticado, nos dois lados
- **Spook:** `GET /api/users/me` devolve o usuário em JSON (leitura da sessão + do usuário no Postgres). Não escreve nada.
- **antrax:** não há endpoint JSON "quem sou eu". O mais leve e sem efeitos colaterais é `GET /settings/profile` (rota só com
  `auth`; a ação `edit` apenas lê). O usuário vem em `props.auth.user`. O cenário usa o modo XHR do Inertia (`X-Inertia: true` e a
  versão dos assets, que o `setup` descobre lendo a página) para receber JSON, como o app faz a cada navegação depois do primeiro
  carregamento, em vez do HTML da página. É uma página Inertia, portanto mais trabalho que um JSON puro; é o que o app tem.
  (Como o antrax usa sessão em banco, toda requisição autenticada atualiza a linha da sessão: custo do framework, incluído.)
- **Sem login em produção:** o cenário recebe o **cookie de sessão por variável de ambiente** (`COOKIE`), de um login que **você**
  fez no navegador (use uma conta descartável). Nada é cadastrado nem logado pelo k6.
- **Como obter o cookie:** com o login feito, abra o DevTools do navegador → *Network* → clique numa requisição ao site →
  *Request Headers* → copie o valor do header `Cookie` inteiro. No Spook o cookie é `spook_session=<token>` (HttpOnly; aparece
  em *Application → Cookies*). No antrax é `laravel_session=…; XSRF-TOKEN=…`. A sessão do Spook dura 30 dias e a do antrax o que o
  `SESSION_LIFETIME` dele definir; se expirar, o `setup` falha com "cookie inválido ou expirado".
- **Segurança:** o cookie vale uma sessão logada. Passe-o por ambiente (`SPOOK_COOKIE`, `ANTRAX_COOKIE`; os scripts o repassam por
  stdin/`-e`, nunca na linha de comando), não o cole em issues nem em logs, e faça logout no navegador ao terminar.
- As métricas do `me.js` têm a tag `name:me`, que deixa o `setup` (1 leitura de validação) fora dos números.

### Login: não é comparado (achado registrado)
A latência do login é dominada por **política**, não pelo framework: o custo de hash escolhido e o `Timebox` do Fortify. Por isso
o login **não** entra na comparação entre os sistemas; o `login.js` mede só o Spook (p95 do critério da Fase 1 e `argon2` do
`Server-Timing`). O que foi verificado no código do antrax e medido fica em `results/fase-1-spook-producao.md` (seção "Login:
algoritmo e custo de hash"): bcrypt custo 12 contra Argon2id (19 MiB, t=2, p=1), o piso de ~200 ms do `Timebox`, e os limites de
5/min (antrax, por e-mail+IP) e 10/min (Spook, por IP).

## 2. Medição pela internet (experiência do usuário)

Da sua máquina (só precisa de Docker). Alterna Laravel e Spook (healthz e `me`) e roda o login do Spook no fim:

```sh
SPOOK_COOKIE='spook_session=…' ANTRAX_COOKIE='laravel_session=…; XSRF-TOKEN=…' \
  bench/scripts/run-alternating.sh /tmp/bench-internet-$(date +%F) 3
node bench/scripts/summarize.mjs /tmp/bench-internet-$(date +%F)
```

`run-alternating.sh` (≈ 30 a 40 min) aceita `RATE`, `DURATION`, `LOGIN_RATE_PER_MIN`, `LOGIN_DURATION`, `ANTRAX_URL`,
`SPOOK_URL`, `PAUSE`. Sem os cookies o cenário autenticado é pulado. Cada execução grava `<nome>.json` (summary do k6) e
`<nome>.log`. Rode antrax e Spook no mesmo horário e da mesma rede.

Comandos avulsos equivalentes:

```sh
docker run --rm -i -v "$PWD/bench:/bench:ro" grafana/k6:1.3.0 run \
  -e BASE_URL=https://antrax.dottadigital.com -e HEALTH_PATH=/up /bench/scenarios/baseline.js
COOKIE='laravel_session=…; XSRF-TOKEN=…' docker run --rm -i -e COOKIE -v "$PWD/bench:/bench:ro" grafana/k6:1.3.0 run \
  -e BASE_URL=https://antrax.dottadigital.com -e ME_PATH=/settings/profile -e ME_STYLE=inertia /bench/scenarios/me.js
```

## 3. Medição interna (backend, sem rede)

### Por que não dá para fazer `curl` de dentro do VPS
Cada app roda em **Docker rootless de um usuário** (`spook`, `antrax`). Cada daemon tem o **próprio namespace de rede**
(rootlesskit): os IPs e as redes dos containers existem só dentro dele e **não são alcançáveis a partir do host**, nem como
`gustavo`, nem como root. O que o host enxerga são só as portas *publicadas*, e os apps HTTP **não publicam nada** (a entrada
é pelo `cloudflared`; do Spook só `7891/tcp` e `7892/udp`, do LiveKit). Então `curl localhost:8090` não funciona.

A saída é rodar o **k6 também em container, na rede Docker do app**, pelo daemon do dono: `sudo -iu <usuário> docker run
--network <rede> …`. Lá o app responde pelo nome do serviço. É o que o `scripts/vps-k6.sh` faz (com `--user 0`, `--cpus 0.25`
e `--memory 192m`).

### Qual é o "serviço interno" de cada um
Use **a mesma origem que o túnel da Cloudflare usa** para o hostname público (Zero Trust → Networks → Tunnels → o túnel →
*Public Hostnames* → coluna *Service*). Assim a medição interna é exatamente "o mesmo alvo, sem Cloudflare/túnel":

| Sistema | Usuário (Docker) | Rede Docker | Alvo interno |
| --- | --- | --- | --- |
| Spook | `spook` (uid 1004) | `spook_default` (projeto Compose `spook`) | `http://spook:8090` (`/healthz`, `/api/auth/login`) |
| antrax | `antrax` (uid 1003, socket `/run/user/1003/docker.sock`) | `antrax-prod_default` (provável; confirme) | `http://web:80` (o *Service* do túnel; provavelmente o nginx, container `antrax-prod-edge-1`) |

Estes são os padrões do `run-internal.sh`. Confirme a rede e o endereço do antrax (lista redes, containers, IPs e portas do daemon dele):

```sh
ssh gustavo@<vps> "sudo -iu antrax bash -s" < bench/scripts/vps-discover.sh
ssh gustavo@<vps> "sudo -iu spook  bash -s" < bench/scripts/vps-discover.sh   # confirma spook_default / spook:8090
```

O alvo do antrax é um proxy (nginx) na frente do app: o `run-internal.sh` envia `Host: antrax.dottadigital.com` e
`X-Forwarded-Proto: https` por padrão, que é o que o `cloudflared` repassa ao origin, para a requisição interna ser a mesma do
caminho real. Mude com `ANTRAX_HOST_HEADER` / `ANTRAX_FORWARDED_PROTO` se o nginx se comportar diferente.

### Rodando
Do seu computador (envia `bench/` para `/tmp/spook-bench` no VPS e roda cada medição lá, como o dono do Docker):

```sh
SPOOK_COOKIE='spook_session=…' ANTRAX_COOKIE='laravel_session=…; XSRF-TOKEN=…' \
  bench/scripts/run-internal.sh gustavo@<vps> /tmp/bench-interno-$(date +%F) 3
node bench/scripts/summarize.mjs /tmp/bench-interno-$(date +%F)
```

Antes das rodadas há uma pré-checagem (1 req/s por 2 s) nos dois alvos e dos dois cookies; se algo falhar, o script para e diz o
quê (alvo errado: use o `vps-discover.sh`; cookie expirado: refaça o login no navegador). Os cookies seguem por stdin até o container
(`STDIN_SECRET` no `vps-k6.sh`), nunca na linha de comando. Sem os cookies só healthz e login do Spook rodam. Variáveis opcionais:
`SPOOK_USER`, `ANTRAX_USER`, `SPOOK_NET`, `SPOOK_TARGET`, `SPOOK_ME_PATH`, `ANTRAX_NET`, `ANTRAX_TARGET`, `ANTRAX_HEALTH_PATH`,
`ANTRAX_ME_PATH`, `RATE`, `DURATION`, `LOGIN_RATE_PER_MIN`, `LOGIN_DURATION`, `PAUSE`, `REMOTE_DIR`.

Pré-requisitos no VPS: SSH como `gustavo` e `sudo -iu spook` / `sudo -iu antrax` **sem senha**; cada daemon puxa
`grafana/k6:1.3.0` do Docker Hub na primeira vez. Sem sudo sem senha, rode à mão (logado no VPS):
`sudo -iu spook /tmp/spook-bench/scripts/vps-k6.sh <nome> <rede> baseline.js -e BASE_URL=http://spook:8090 …`.

**Cuidados.** O container do k6 consome do **mesmo slice** (CPU/memória) do app medido (3G, 1 CPU para o Spook). Com a carga
leve padrão é desprezível e os limites do `vps-k6.sh` o contêm; para cargas altas (Fase 3 em diante) isso precisa ser
reavaliado. A medição interna é produção: mantenha a carga leve, e não rode junto com deploy ou outro teste.

## 4. Resultados e dados brutos
`results/fase-0-laravel-baseline.md` (antrax) e `results/fase-1-spook-producao.md` (Spook, e os dois lado a lado). Dados
brutos (summary JSON e logs) em `results/raw/<data>-<tipo>/`: `2026-10-30-producao/` é a medição pela internet. O
`summarize.mjs` rotula cada grupo como *Internet* ou *Interno* (arquivos `internal-*`).

Cada execução do `login.js` cadastra um usuário de teste e o `scripts/smoke-prod.mjs` cria um usuário descartável; **não há
rota de excluir conta**. Os usernames saem no log do k6 (`usuario_de_teste ...`) e na saída do smoke. Para removê-los, como
usuário `spook`, em `/srv/spook/prod`:

```sh
docker compose --env-file .env -f deploy/docker-compose.prod.yml exec postgres psql -U spook -d spook \
  -c "DELETE FROM users WHERE email LIKE '%@bench.spook.invalid' OR email LIKE '%@smoke.spook.invalid'"
```

## 5. Custo do hash de senha (domina a latência do login)

A tabela comparativa está em `results/fase-1-spook-producao.md` (seção "Login: algoritmo e custo de hash"). Para medir, na
**mesma máquina**, os dois lados:

```sh
# Spook: Argon2id em Go (a raiz do repositório; o script entra em server/ sozinho)
scripts/go.sh test -run '^$' -bench . -benchtime 20x ./internal/auth
# antrax: bcrypt e, de quebra, Argon2id em PHP (libargon2) com os parâmetros do Spook
docker run --rm -v "$PWD/bench/scripts:/s:ro" php:8.4-cli php /s/hash-cost.php 20
```

No VPS, o número que vale para o Spook é o `argon2` do `Server-Timing` (rodando o `login.js`). Para o antrax, rode o
`hash-cost.php` **dentro do container do app dele** (mesmo PHP e mesma CPU de produção):

```sh
ssh gustavo@<vps> "sudo -iu antrax docker exec -i <container-do-app> php" < bench/scripts/hash-cost.php
```

## 6. RAM ociosa (mediana de N amostras)

`scripts/docker-stats.sh [amostras=10] [intervalo=5] [filtro-regex=.]` coleta N amostras de `docker stats --no-stream`,
converte para MiB e imprime a **mediana por container** e a soma da stack (`STATS_CSV=1` despeja as amostras brutas em
stderr). Rode com o sistema sem tráfego (sem k6 nem deploy em andamento). O Docker é rootless por usuário, então o
script roda como o dono do daemon. Do seu computador, **como `gustavo`**, com o script indo por stdin:

```sh
ssh gustavo@<vps> "sudo -iu spook  bash -s -- 10 5" < bench/scripts/docker-stats.sh   # Spook
ssh gustavo@<vps> "sudo -iu antrax bash -s -- 10 5" < bench/scripts/docker-stats.sh   # antrax, para comparar
```

(Se o `sudo` pedir senha ou terminal, use `ssh -t` ou entre no servidor.) Registre o container `spook-spook-1` (meta do SPEC,
RNF01: < 100 MB) e a soma da stack. Para o backend do antrax, some `app + reverb + queue + scheduler`.

## 7. Smoke de produção (não é benchmark)
`node scripts/smoke-prod.mjs https://spook.dottadigital.com`: cadastro, login, avatar direto no storage e CORS.
