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
| `messages.js` | só o Spook | `GET /api/channels/{id}/messages` (histórico por cursor, 2 páginas por iteração) e `POST` (envio, ≤ 0,8 msg/s por causa do limite de 5/5 s) | **não** (o antrax não tem este fluxo equivalente) |
| `gateway-connections.js` | só o Spook | N conexões WebSocket ociosas (handshake, IDENTIFY→READY, heartbeats) | **não** (ver Fase 3 abaixo) |
| `gateway-latency.js` | só o Spook | latência ponta a ponta: envio por REST → `MESSAGE_CREATE` no WebSocket | **não** |
| `gateway-fanout.js` | só o Spook | fan-out com N usuários conectados (Fase 4): entregas/s, perdas e latência (insumo de "CPU e mensagens/s com N usuários") | **não** |
| `upload.js` | só o Spook | fluxo de anexo (Fase 6): pedido da URL, PUT direto no storage (throughput) e envio da mensagem com o anexo | **não** |
| `read-states.js` | só o Spook | não lidas (Fase 6b): `GET /api/users/@me/read-states` (consulta por canal, teto de 100) e `PUT /api/channels/{id}/ack` | **não** |
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

### `messages.js`: histórico e envio (Fase 2)
Mede o caminho quente do chat no Spook: a listagem paginada por cursor e o envio. Variáveis: `BASE_URL`, `COOKIE` e **`CHANNEL_ID`**
(obrigatórias), `HISTORY_RATE` (5 req/s), `SEND_RATE` (0,8 msg/s; o servidor limita a 5 mensagens a cada 5 s por usuário e canal, então
mais que 1/s gera 429, contado em `send_rate_limited`), `DURATION`, `PAGE_SIZE` (50). O `Server-Timing` do histórico entra como
`server_timing_app` e `server_timing_db`.
- **O envio escreve mensagens.** Use um servidor e um canal de **teste**, com uma conta descartável; nunca um canal real.
- **Canal com muito histórico:** `scripts/seed-messages.sql` insere N mensagens (padrão sugerido: 1.000.000, via `generate_series`)
  direto no Postgres de um canal de teste, para a listagem rodar sobre um volume realista. O uso (psql) está no cabeçalho do arquivo.
  É um insert direto no banco: rode só no ambiente de teste, e entenda o script antes. Para limpar, o próprio arquivo traz o `DELETE`.
- Exemplo (cookie por ambiente, nunca na linha de comando):
  `COOKIE='spook_session=…' docker run --rm -i -e COOKIE -v "$PWD/bench:/bench:ro" grafana/k6:1.3.0 run -e BASE_URL=http://host.docker.internal:8090 -e CHANNEL_ID=<id> /bench/scenarios/messages.js`
- A execução contra produção e o registro dos resultados são da Fase B.

### `gateway-connections.js`, `gateway-latency.js` e `gateway-fanout.js`: o gateway WebSocket (Fases 3 e 4)
Só o Spook. Os dois falam o protocolo da SPEC 5.3 (HELLO → IDENTIFY → READY, heartbeat no intervalo informado) com `k6/ws`.
Autenticam com o cookie de sessão (`COOKIE`, header Cookie inteiro) ou, com `TICKET=1`, trocam o cookie por um ticket de uso único
(`POST /api/gateway/ticket`, o caminho do desktop). **Nunca contra produção sem combinar a carga** (Fase B).

| Cenário | Mede | Variáveis |
| --- | --- | --- |
| `gateway-connections.js` | N conexões ociosas: handshake (`ws_connecting`), IDENTIFY→READY (`gw_identify_ms`), heartbeats com ACK (`gw_heartbeat_ack`) e quedas inesperadas (`gw_unexpected_close`, deve ser 0) | `BASE_URL`, `COOKIE` ou `MULTI_COOKIES` (`c1\|c2\|…`), `CONNECTIONS` (100), `RAMP` (30s), `HOLD` (60s), `TICKET`, `HEARTBEAT_MS` |
| `gateway-fanout.js` | fan-out com N usuários (Fase 4): N sockets no mesmo canal e poucos remetentes a taxa fixa; mede entregas/s (`gw_received`), perdas (`gw_expected` - `gw_received`) e latência ponta a ponta | `BASE_URL`, `CHANNEL_ID`, `MULTI_COOKIES` (receptores, ≥ N/20 contas), `SENDER_COOKIES`, `RECEIVERS` (100), `RAMP` (30s), `DURATION` (60s), `SEND_RATE` (até 2/s no total; ≤ 0,8/s por remetente), `TICKET` |
| `gateway-latency.js` | latência ponta a ponta: um remetente envia por REST `bench:<epoch ms>:<n>` e `RECEIVERS` sockets registram `now - ts` em `gw_e2e_latency_ms` (meta p95 < 100 ms, RNF01; o remetente e os receptores estão no mesmo k6, então o relógio é o mesmo) | `BASE_URL`, `COOKIE` (remetente), `CHANNEL_ID`, `MULTI_COOKIES` (receptores), `RECEIVERS` (10), `SEND_RATE` (0,8/s), `DURATION` (60s), `TICKET` |

- **Limites do servidor que afetam a carga:** até **20 sessões por usuário** (para mais conexões, passe `MULTI_COOKIES` com várias contas de teste,
  em número ≥ `CONNECTIONS`/20), handshake limitado a **50/s por IP** com rajada de 200 (mantenha `CONNECTIONS/RAMP` ≤ 50), 120 ops por minuto por conexão
  e 5 mensagens a cada 5 s por usuário e canal (`gateway-latency.js` fica em 0,8 msg/s; acima disso há 429, contado em `send_rate_limited`).
- **O `gateway-latency.js` escreve mensagens**: canal de **teste**, conta descartável.
- **Smoke local** (sem produção): suba o backend (`pnpm dev`) e rode, por exemplo,
  `docker run --rm -i -e COOKIE -e MULTI_COOKIES -v "$PWD/bench:/bench:ro" grafana/k6:1.3.0 run -e BASE_URL=http://host.docker.internal:8090 -e CONNECTIONS=50 -e RAMP=10s -e HOLD=30s /bench/scenarios/gateway-connections.js`.
- **Conexões por GB de RAM.** O k6 só gera a carga; a RAM vem do backend. Receita: (1) com o backend **ocioso** (sem conexões), meça a RAM base com
  `docker-stats.sh` (seção 6); (2) rode `gateway-connections.js` com `CONNECTIONS=N` e, durante o `HOLD` (já sem rampa), rode `docker-stats.sh 5 5` e pegue a mediana
  do container `spook`; (3) `conexões por GB = N / (RAM_com_N_conexões_em_GB)` e, para o custo marginal, `(RAM_N - RAM_base) / N` por conexão
  (`1 GB / custo marginal` = conexões por GB só de conexões). Repita para N crescente (500, 2.000, 5.000, 10.000) e registre a curva. O gauge
  `spook.gateway.connections` (OTLP) confirma quantas conexões o servidor viu. Atenção ao ulimit de arquivos do container do k6 e do backend (um socket por conexão)
  e ao slice de 3 GB/1 CPU do VPS, que o k6 divide com o app na medição interna.
- **`gateway-fanout.js` (Fase 4) e "CPU e mensagens/s com N usuários conectados".** Cria N conexões (ao longo de `RAMP`), espera 5 s e envia `SEND_RATE`
  mensagens/s pelos remetentes durante `DURATION`; cada mensagem deve chegar aos N sockets (esperado = enviadas × N). O resumo final imprime entregas/s, perdas e
  o p95 ponta a ponta. Receita: (1) deixe o backend ocioso e meça a CPU base (`docker-stats.sh`, seção 6); (2) rode o cenário com `RECEIVERS=N`; (3) durante o envio
  (depois de `RAMP` + 5 s), rode `docker-stats.sh 5 5` e pegue a mediana de CPU do container `spook`; (4) registre `CPU(N)`, entregas/s e perda para N crescente
  (100, 500, 2.000, 5.000). Como o limite é de 5 mensagens a cada 5 s por usuário e canal, aumente o fan-out com mais destinatários, não com mais envio por conta;
  para mais entregas/s use mais remetentes (`SENDER_COOKIES`). **O cenário escreve mensagens**: canal e contas de **teste**, e nunca contra produção sem combinar a carga (Fase B).
  Exemplo local: `docker run --rm -i -e MULTI_COOKIES -e SENDER_COOKIES -v "$PWD/bench:/bench:ro" grafana/k6:1.3.0 run -e BASE_URL=http://host.docker.internal:8090 -e CHANNEL_ID=<id> -e RECEIVERS=200 -e RAMP=10s -e DURATION=30s /bench/scenarios/gateway-fanout.js`.
- Métricas do backend da Fase 4 (OTLP): `spook.presence.users{status=online|idle}` (gauge), `spook.presence.transitions{status}` (contador), `spook.typing.started` (contador de TYPING_START
  publicados, depois do throttle) e `spook.dm.created{kind=dm|group}`; spans `presence.transition`, `presence.member_joined`, `presence.snapshot`, `typing.Start` e `dm.*`.
- Métricas do backend (OTLP, `SPOOK_OTLP_ENDPOINT`): `spook.gateway.connections`, `spook.gateway.sessions`, `spook.gateway.events.dispatched`, `spook.gateway.resumes`,
  `spook.gateway.invalid_sessions`, `spook.gateway.slow_consumer_closes`, `spook.gateway.publish_to_write.duration` (publicação → escrita no socket) e as métricas de runtime do Go.

### Voz (Fase 5): `voice-token.js` e `livekit-load-test.sh`
Duas medições complementares, **só escritas e versionadas aqui; a execução e o registro dos resultados são da Fase B** (nunca contra produção sem combinar a carga).

| Ferramenta | Mede | Variáveis |
| --- | --- | --- |
| `scenarios/voice-token.js` | latência do `POST /api/channels/{id}/voice/token` (autorização do canal + assinatura do JWT): `http_req_duration{name:voice_token}`, `server_timing_app`, 429 em `voice_token_rate_limited` e tokens malformados em `voice_token_invalid` (deve ser 0) | `BASE_URL`, `COOKIE`, `CHANNEL_ID` (canal de voz com CONNECT ou DM da conta), `RATE` (5), `DURATION` (60s) |
| `scripts/livekit-load-test.sh` | CPU, memória e banda do **LiveKit** por participante, com publicadores e assinantes simulados pelo `lk load-test` (imagem `livekit/livekit-cli`); amostra o container do servidor com `docker stats` e grava um CSV | `LK_URL`, `LK_API_KEY`, `LK_API_SECRET`, `AUDIO_PUBLISHERS`, `VIDEO_PUBLISHERS`, `SUBSCRIBERS`, `NUM_PER_SECOND`, `DURATION`, `SERVER_CONTAINER`, `STATS_OUT` (lista completa no cabeçalho do script) |

- **`voice-token.js`** exige voz ligada no servidor (`LIVEKIT_*`); sem isso o `setup` falha com "voz desligada" (503). Cada token cria uma intenção pendente de 30 s em memória e, se a
  conta já estiver em outro canal de voz, tira-a de lá: use **conta e canal de teste**. Exemplo local:
  `COOKIE='spook_session=…' docker run --rm -i -e COOKIE -v "$PWD/bench:/bench:ro" grafana/k6:1.3.0 run -e BASE_URL=http://host.docker.internal:8090 -e CHANNEL_ID=<id do canal de voz> /bench/scenarios/voice-token.js`.
  Métricas do backend (OTLP): `spook.voice.token.duration` (histograma, s), `spook.voice.tokens.issued{kind=guild|dm}`, `spook.voice.tokens.denied{reason}`,
  `spook.voice.webhooks{type}`, `spook.voice.participants{channel_type=guild|dm}` (gauge), `spook.voice.evictions` e `spook.voice.reconcile.orphans`; spans `voice.IssueToken`, `voice.Leave`,
  `voice.SetSelfState`, `voice.Webhook`, `voice.Reevaluate` e `voice.Reconcile`.
- **`livekit-load-test.sh`** não passa pelo backend: o `lk` entra direto no LiveKit com uma sala própria (`bench-<epoch>`), então não toca em canais nem usuários do Spook e também não mede
  token nem webhook. Receita de **CPU/banda por participante**: (1) amostre o container ocioso (`AUDIO_PUBLISHERS=0 SUBSCRIBERS=0 DURATION=20s`); (2) rode com N participantes e
  `SERVER_CONTAINER=spook-livekit-1` (local) e pegue a mediana das amostras depois da rampa (`N / NUM_PER_SECOND` s); (3) custo por participante = `(CPU(N) − CPU_base) / N` (idem para banda);
  (4) repita para N crescente (10, 25, 50, 100) e registre a curva. Em produção a mídia sai pelo IP público (7891/tcp, 7892/udp) e o container tem teto de 0,5 CPU/512M: rode o
  cli de fora do VPS. O script recusa URLs `*.dottadigital.com` sem `I_KNOW_THIS_IS_PRODUCTION=yes`.

### Uploads (Fase 6): `upload.js` e o tempo do job de thumbnail
**Só escrito e versionado aqui; a execução e o registro dos resultados são da Fase B** (nunca contra produção sem combinar a carga).

- **O que o cenário faz.** Em cada iteração: `POST /api/channels/{id}/uploads` (`name=upload_request`), `PUT` do arquivo direto na URL pré-assinada do storage, **sem cookie** (`name=upload_put`), e `POST /api/channels/{id}/messages` com `attachment_ids` (`name=upload_send`; o servidor confere o objeto no storage e grava mensagem + anexo numa transação). Mede também `upload_put_throughput_mbps` (MB/s do PUT por arquivo), `upload_bytes`, `upload_rate_limited` (429 do limite de 30 pedidos/min), `send_rate_limited` e `upload_flow_failed` (deve ser 0).
- **Variáveis.** `BASE_URL`, `COOKIE` e `CHANNEL_ID` (canal de texto ou DM com ATTACH_FILES) obrigatórias; `KIND` (`zip`, padrão, ou `png`), `FILE_KB` (tamanho do zip, 512; até 25600), `IMG_WIDTH`/`IMG_HEIGHT` (PNG, 1600x1200 ≈ 5,5 MB), `UPLOADS_PER_MIN` (12), `DURATION` (60s), `HOST_HEADER`, `FORWARDED_PROTO`. Os arquivos são gerados no próprio script (o PNG é válido, RGB com deflate "stored", para o job de thumbnail ter o que decodificar). **Escreve** anexos, mensagens e objetos: use conta, servidor e canal de **teste**.
- **Exemplo local** (com `pnpm infra:up` e o backend em `:8090`): `COOKIE='spook_session=…' docker run --rm -i -e COOKIE -v "$PWD/bench:/bench:ro" grafana/k6:1.3.0 run -e BASE_URL=http://host.docker.internal:8090 -e CHANNEL_ID=<id> -e KIND=png -e IMG_WIDTH=3000 -e IMG_HEIGHT=2000 /bench/scenarios/upload.js` (o `S3_ENDPOINT` do servidor precisa ser alcançável pelo k6, pois a URL de PUT aponta para ele).
- **Throughput.** `upload_put_throughput_mbps` (e `http_req_duration{name:upload_put}`) mede a rede até o storage; o backend não está no caminho. A latência do backend é `upload_request` e `upload_send` (+ `server_timing_app`/`server_timing_db`). Varie `FILE_KB` (256, 1024, 4096, 16384, 25600) e registre a curva MB/s × tamanho.
- **Tempo do job de thumbnail** (não aparece nas métricas do k6, porque é assíncrono; use o backend):
  1. *Métricas (OTLP/Prometheus):* `spook.thumbnail.job.duration` (histograma em segundos, com `result=ok|discarded|error`) é o tempo do job (download do original, decodificação, redimensionamento, upload e gravação); `spook.thumbnail.jobs{result}` conta; `spook.jobs.queue.size{queue="thumbnail"}` é a fila esperando (cresce se `UPLOADS_PER_MIN` passar do que 2 workers aguentam). A latência "envio da mensagem → thumbnail visível" é essa duração + a espera na fila (+ ≤ 1 s do polling do River); no gateway, é o intervalo entre `MESSAGE_CREATE` e o `MESSAGE_UPDATE` da mesma mensagem (`gateway-latency.js` pode ser estendido).
  2. *Logs:* cada job termina com `thumbnail gerado attachment=<id> ms=<duração>` (nível INFO); falhas são `thumbnail falhou` (retentável) ou `thumbnail descartado` (sem retentativa).
  3. *Traces:* span `attachment.thumbnail` (com `job.result`, `job.attempt`) e filhos `.download`, `.resize` e `.upload`, que mostram onde o tempo vai (a decodificação/CatmullRom domina em fotos grandes).
  4. *Banco:* `select (finalized_at - attempted_at) from river_job where kind = 'thumbnail' order by id desc limit 50;` dá a duração por job e `attempted_at - scheduled_at` a espera na fila.
  Receita: `KIND=png` com `IMG_WIDTH×IMG_HEIGHT` crescentes (800x600, 1600x1200, 3000x2000, 4000x3000 = 12 MP, o máximo aceito), `UPLOADS_PER_MIN=12`; leia a mediana e o p95 de `spook.thumbnail.job.duration` e a memória do container `spook` (`docker stats`) durante a rampa para validar o teto de 512M com 2 workers.

### Não lidas e ack (Fase 6b): `read-states.js`
**Só escrito e versionado aqui; a execução e o registro dos resultados são da Fase B** (nunca contra produção sem combinar a carga).

- **O que o cenário faz.** Dois cenários em paralelo, ambos `constant-arrival-rate`: `GET /api/users/@me/read-states` a `RATE` req/s (`name=read_states`) e `PUT /api/channels/{CHANNEL_ID}/ack` a `ACK_RATE` req/s (`name=ack`). O `setup` lê a última mensagem do canal e o ack a usa; depois do primeiro ele não muda o estado (a leitura nunca regride), então mede o caminho do upsert. Mede também `read_states_channels` (quantos canais cada GET devolveu), `read_states_capped` (canais no teto de 100 não lidas), `ack_failed` (deve ser 0) e o `Server-Timing` (`server_timing_app`/`server_timing_db`).
- **Variáveis.** `BASE_URL`, `COOKIE` e `CHANNEL_ID` (canal de texto ou DM da conta) obrigatórias; `RATE` (5), `ACK_RATE` (2), `DURATION` (60s), `HOST_HEADER`, `FORWARDED_PROTO`. Use uma conta **descartável** (o ack escreve em `read_states`).
- **Exemplo local:** `COOKIE='spook_session=…' docker run --rm -i -e COOKIE -v "$PWD/bench:/bench:ro" grafana/k6:1.3.0 run -e BASE_URL=http://host.docker.internal:8090 -e CHANNEL_ID=<id> /bench/scenarios/read-states.js`.
- **Como o custo escala.** O GET é **uma consulta** por requisição, qualquer que seja o número de canais (um teste de integração prova que o número de idas ao banco não cresce com os canais). Cada canal só paga a contagem quando `channels.last_message_id > last_read`, e a contagem para em 100 (`LIMIT 100` sobre o índice `(channel_id, id DESC)`). Para a curva realista, rode com contas em 10, 50 e 200 canais com mensagens não lidas e registre p50/p95 × nº de canais.
- **No backend:** `spook.readstate.query.duration` (histograma, s) é o tempo da consulta de não lidas; `spook.readstate.acks` conta os acks; `spook.mentions.detected` conta os mencionados; `spook.push.jobs{result=sent|removed|failed|skipped}` e `spook.push.job.duration` medem o Web Push; `spook.jobs.queue.size{queue="push"}` é a fila; `spook.notification.dropped{reason}` indica `MESSAGE_CREATE` descartados (fila de 4.096 cheia ou erro). Spans: `notification.ReadStates`, `notification.Ack`, `notification.OnMessage`, `notification.ResolveMentions`, `notification.push`.

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
