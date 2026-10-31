# Spook — Especificação do Projeto

> Documento de referência para implementação com o Claude Code.
> Contém apenas as decisões finais. Itens não decididos estão em **Questões em aberto**.
> Última atualização: 30/10/2026

---

## 1. Objetivo

Spook é um clone do Discord construído **para estudo**: aprender novas ferramentas (Go, LiveKit, Tauri) e praticar engenharia de performance.

O critério de sucesso é técnico. Cada fase entrega uma funcionalidade usável **e** uma medição comparável com a versão anterior do projeto (Laravel + React + Electron), que foi descontinuada e serve apenas como baseline de benchmark.

---

## 2. Escopo

### 2.1 Entra (fases 0 a 7)

- Contas de usuário: cadastro, login, logout, perfil
- Servidores (guilds), canais de texto e de voz, membros, convites
- Cargos (roles) com permissões em bitflags
- Mensagens em tempo real: enviar, editar, excluir, histórico paginado
- DMs (1:1) e DMs em grupo
- Presença (online, ausente, offline) e indicador de "digitando…"
- Voz, vídeo e compartilhamento de tela via LiveKit
- Upload de arquivos e imagens, com thumbnails
- Notificações in-app e web push; contagem de não lidas
- Cliente web e cliente desktop (Tauri)
- Observabilidade e suíte de benchmark comparativa

### 2.2 Fica de fora (por enquanto)

- **Fase 8:** app mobile (Expo). Começa só após uso real e feedback da fase 7.
- **Fase 9:** overengineering (NATS com múltiplas instâncias do gateway, busca com Meilisearch, cache, testes de caos).
- Bots e API pública
- Criptografia ponta a ponta
- Gravação de chamadas
- Moderação avançada (automod, logs de auditoria)
- Reações, threads, menções com autocomplete, embeds de links
- Permissões por canal (overwrites); só há permissões por cargo no servidor
- Multi-idioma (i18n)
- Login social (OAuth) e 2FA

---

## 3. Requisitos funcionais

### RF01 — Contas
- RF01.1 Cadastro com e-mail, nome de usuário e senha.
- RF01.2 Login e logout.
- RF01.3 Edição de perfil: nome de exibição e avatar.

### RF02 — Servidores
- RF02.1 Qualquer usuário cria um servidor e se torna dono.
- RF02.2 O dono pode renomear, trocar o ícone, excluir o servidor e transferir a posse.
- RF02.3 Membros entram por convite e podem sair do servidor (exceto o dono).
- RF02.4 Membros com permissão podem expulsar outros membros.

### RF03 — Convites
- RF03.1 Gerar convite com código único, expiração opcional e limite de usos opcional.
- RF03.2 Entrar no servidor pelo código do convite.
- RF03.3 Revogar convite.

### RF04 — Cargos e permissões
- RF04.1 Criar, editar e excluir cargos com nome, cor, posição e permissões.
- RF04.2 Atribuir e remover cargos de membros.
- RF04.3 Todo servidor tem o cargo `@everyone`, que não pode ser excluído.

### RF05 — Canais
- RF05.1 Criar, renomear, reordenar e excluir canais de texto e de voz.
- RF05.2 Agrupar canais em categorias.

### RF06 — Mensagens
- RF06.1 Enviar mensagem de texto, com anexos opcionais.
- RF06.2 Editar e excluir a própria mensagem.
- RF06.3 Excluir mensagem de outros com a permissão adequada.
- RF06.4 Histórico paginado por cursor (rolagem infinita para cima).
- RF06.5 Mensagens chegam em tempo real para todos os membros com acesso ao canal.

### RF07 — DMs
- RF07.1 Abrir DM 1:1 com qualquer usuário que compartilhe um servidor.
- RF07.2 Criar DM em grupo, adicionar e remover participantes.

### RF08 — Presença
- RF08.1 Status online, ausente e offline, visível para quem compartilha servidor ou DM.
- RF08.2 Indicador "digitando…" por canal.

### RF09 — Voz, vídeo e tela
- RF09.1 Entrar e sair de um canal de voz.
- RF09.2 Silenciar microfone e desativar áudio (mute/deafen).
- RF09.3 Ligar câmera.
- RF09.4 Compartilhar tela (com áudio do sistema onde a plataforma permitir).
- RF09.5 Todos os membros veem quem está em cada canal de voz, em tempo real.
- RF09.6 Voz, vídeo e tela também funcionam em DMs.

### RF10 — Uploads
- RF10.1 Anexar arquivos às mensagens via URL pré-assinada.
- RF10.2 Gerar thumbnails de imagens de forma assíncrona.

### RF11 — Notificações
- RF11.1 Contagem de mensagens não lidas por canal e por servidor.
- RF11.2 Notificação in-app de nova mensagem.
- RF11.3 Web push para DMs e menções quando o usuário estiver offline.

### RF12 — Desktop
- RF12.1 O app Tauri oferece todas as funcionalidades da web.
- RF12.2 Voz, vídeo e tela no desktop usam captura nativa em Rust, não o WebRTC do WebView.
- RF12.3 Instaladores para Windows, macOS e Linux.

---

## 4. Requisitos não funcionais

### RNF01 — Performance (metas iniciais; recalibrar após o baseline do Laravel)

| Métrica | Meta |
| --- | --- |
| Latência ponta a ponta de mensagem (envio → recebimento), p95 | < 100 ms |
| Latência de endpoints REST, p95 | < 50 ms |
| Conexões WebSocket simultâneas | ≥ 10.000 no VPS |
| RAM ociosa do backend | < 100 MB |
| Listagem de mensagens com 1M de linhas no banco, p95 | < 30 ms |
| Lista de mensagens no front | 60 fps com 10.000 mensagens carregadas |

### RNF02 — Observabilidade
- Todo endpoint e evento do gateway é instrumentado com OpenTelemetry (traces e métricas).
- Métricas no Prometheus, logs estruturados no Loki, dashboards no Grafana.
- O backend expõe pprof em ambiente de desenvolvimento.

### RNF03 — Mensurabilidade
- Toda fase termina com um benchmark k6 reproduzível, versionado no repositório.
- Os mesmos cenários rodam contra o Laravel e o Spook, no mesmo VPS e com o mesmo volume de dados. O baseline do Laravel é medido contra `antrax.dottadigital.com`, que roda no mesmo VPS e no mesmo padrão de deploy (RNF05).
- Toda medição é registrada em dois tipos, lado a lado: **pela internet** (experiência do usuário, com Cloudflare e túnel no caminho) e **interna** (backend, k6 na rede Docker do app no VPS, sem Cloudflare/túnel). O backend expõe o header `Server-Timing` com o tempo de processamento da requisição. Além do health check, o cenário comparável de aplicação é o GET do usuário autenticado (cookie de sessão por variável de ambiente, sem login em produção). A latência de login não é comparada entre os sistemas, por ser dominada por política (custo de hash e atrasos de segurança, não o framework); o achado, com o algoritmo e o custo de hash de cada lado, fica registrado nos resultados.

### RNF04 — Segurança
- Senhas com Argon2id.
- Toda ação é autorizada no backend; o front nunca é fonte de verdade.
- Rate limiting por usuário e por IP nas rotas REST e no gateway.
- Uploads validados por tipo e tamanho; URLs pré-assinadas de curta duração.
- Tokens do LiveKit emitidos pelo backend, com escopo de uma sala e expiração curta.

### RNF05 — Infraestrutura
- Tudo roda no VPS Hostinger KVM 2 (2 vCPU, 8 GB RAM, 100 GB NVMe, 8 TB de banda) via Docker Compose, no mesmo padrão do antrax: cada app tem seu usuário Linux (o do Spook é `spook`) com Docker rootless. O deploy não usa root.
- Ninguém escuta em 80/443. A entrada é por Cloudflare Tunnel: o Spook tem seu próprio túnel e seu próprio container `cloudflared`. O TLS é terminado na Cloudflare.
- Domínios (DNS na Cloudflare), todos via túnel:

  | Host | Serviço (via túnel) |
  | --- | --- |
  | `spook.dottadigital.com` | Web + API + gateway WebSocket |
  | `spook-rtc.dottadigital.com` | LiveKit (sinalização) |
  | `spook-files.dottadigital.com` | Garage (URLs pré-assinadas) |

  Todos ficam em um único nível de subdomínio, cobertos pelo certificado gratuito da Cloudflare.
- A mídia do LiveKit não passa pelo túnel: vai direto pelo IP público do VPS (`--node-ip 187.127.26.46`), em `7891/tcp` e `7892/udp`, portas que não colidem com as do antrax. Essas portas são liberadas no firewall da Hostinger. Sem TURN/TLS por enquanto; se for preciso TURN, ele usa UDP em porta livre.

### RNF06 — Qualidade
- Lint e formatação: golangci-lint (Go) e Biome (TypeScript).
- CI roda lint, testes unitários e build a cada push.
- Testes E2E com Playwright cobrem os fluxos críticos.

### RNF07 — Resiliência
- O cliente reconecta automaticamente ao gateway e retoma a sessão sem perder eventos (resume).
- A queda de uma conexão não afeta as demais.

---

## 5. Stack e decisões técnicas

| Camada | Decisão | Motivo |
| --- | --- | --- |
| Backend | **Go 1.26** (fixado pela diretiva `toolchain` do `go.mod`), monólito modular (API REST + gateway WebSocket no mesmo binário) | Objetivo de aprender Go; mesmo ecossistema do LiveKit; construir o realtime à mão é parte do aprendizado. API e gateway juntos simplificam o deploy. |
| Roteador HTTP | chi | 100% compatível com `net/http`; idiomático e sem prender o código a um framework |
| API e OpenAPI | huma (code-first) sobre o chi | Structs Go geram o spec e a validação; sem duplicar contrato à mão |
| Autenticação | Sessão própria no Go. Web: cookie httpOnly, Secure, SameSite=Lax. Desktop: token de sessão no keychain do SO, enviado por header | Cookie httpOnly não é acessível por JS (protege contra XSS); o Tauri não depende de cookies entre origens |
| WebSocket | coder/websocket | Biblioteca moderna e mantida, compatível com `context` |
| Acesso a banco | sqlc + pgx | SQL tipado e gerado, sem ORM; controle total das queries |
| Migrations | goose | Simples, com SQL puro |
| Jobs | River | Fila sobre o próprio Postgres, sem Redis |
| Banco | PostgreSQL | Um único banco relacional resolve tudo nessa escala |
| IDs | Snowflake (bigint de 64 bits) | Ordenação temporal embutida; paginação por cursor sem coluna extra |
| Contrato | OpenAPI gerado pelo huma → orval → TanStack Query + Zod | Tipos ponta a ponta entre Go e TypeScript |
| Cliente HTTP | fetch nativo, via mutator customizado do orval (headers, erros, retry) | Zero dependência; igual na web, no Tauri e no Expo. Progresso de upload para o Garage usa um `XMLHttpRequest` isolado |
| Mídia | LiveKit self-hosted, com TURN embutido | Produtivo, com SDKs para web, Rust e React Native |
| Arquivos | Garage (compatível com S3) + URL pré-assinada | MinIO Community descontinuado; Garage é leve, mantido e compatível com S3. O cliente sobe direto, sem passar pelo backend |
| Web | React 19 + TypeScript + Vite | Base moderna |
| Roteamento | TanStack Router | Rotas e params tipados; prefetch integrado ao TanStack Query |
| UI | Tailwind + shadcn/ui | Componentes acessíveis e customizáveis |
| Ícones | lucide-react | Padrão do shadcn; estilo consistente |
| Toasts | Sonner | Substituto oficial do toast antigo do shadcn |
| Tema claro/escuro | ThemeProvider próprio, conforme a doc do shadcn para Vite | Sem dependência pensada para Next.js |
| Estado do servidor | TanStack Query | Cache, invalidação e sincronização com eventos do gateway |
| Estado do cliente | Zustand | Estado do gateway: conexão, presença, digitando, voz |
| Formulários | React Hook Form + Zod | Validação tipada |
| Lista de mensagens | TanStack Virtual | Maior ganho de performance no front de um chat; controle total sobre rolagem invertida, histórico acima e alturas dinâmicas |
| Otimização React | React Compiler | Memoização automática, mensurável antes e depois |
| Datas | date-fns | Leve e modular |
| Testes front | Vitest + React Testing Library + Playwright + MSW | Unitários, componentes, E2E e API mockada |
| Tooling front | pnpm + Biome + Turborepo | Monorepo rápido; lint e formatação numa ferramenta só |
| Desktop | Tauri 2; voz, vídeo e tela via Rust + LiveKit Rust SDK | App leve; o WebRTC do WebView é instável no Linux (WebKitGTK) e tem problemas de permissão no macOS |
| Infra | Docker Compose rootless + Cloudflare Tunnel | Tudo num VPS, um usuário Linux por app, sem portas 80/443 abertas; TLS na Cloudflare |
| Observabilidade | OpenTelemetry + Prometheus + Grafana + Loki | Base da comparação com o Laravel |
| Benchmark | k6 (HTTP e WebSocket), LiveKit load test, `getStats()`, pprof | Medição reproduzível |

### 5.1 Estrutura do repositório

```
spook/                      pnpm + Turborepo
├─ apps/
│  ├─ web/                  React + Vite
│  └─ desktop/              Tauri 2 (reusa a web; mídia em Rust)
├─ packages/
│  ├─ shared/               tipos, schemas Zod, client da API (orval), client do gateway
│  └─ brand/                logos, ícones e tokens da identidade visual (ver seção 9)
├─ server/
│  ├─ cmd/spook/main.go     wiring: config, dependências, start
│  ├─ internal/
│  │  ├─ auth/
│  │  ├─ user/
│  │  ├─ guild/
│  │  ├─ channel/
│  │  ├─ message/
│  │  ├─ invite/
│  │  ├─ voice/             tokens e webhooks do LiveKit
│  │  ├─ upload/
│  │  ├─ notification/
│  │  ├─ presence/
│  │  ├─ gateway/           hub WebSocket, sessões, fan-out
│  │  └─ platform/          db, logger, métricas, config, jobs, snowflake
│  ├─ db/
│  │  ├─ migrations/
│  │  └─ queries/           .sql consumidos pelo sqlc
│  └─ api/openapi.yaml
├─ bench/                   cenários k6 e scripts de comparação
└─ deploy/                  docker-compose, cloudflared, config do LiveKit
```

### 5.2 Regras de arquitetura do backend

- Cada feature tem três camadas: `handler` (HTTP) → `service` (regra de negócio) → `store` (SQL).
- Uma feature não importa o `store` de outra; a comunicação é via `service` ou eventos.
- O `service` não conhece HTTP nem SQL.
- Só o pacote `gateway` conhece WebSocket; os services publicam eventos num barramento interno.
- Interfaces são definidas por quem consome, e só onde há troca real (banco, LiveKit, storage, push).
- Injeção de dependência manual no `main.go`, sem framework.
- A feature `voice` usa arquitetura hexagonal completa (porta para o LiveKit), como exercício de estudo.

### 5.3 Gateway (protocolo)

- Uma conexão WebSocket por cliente, autenticada no handshake.
- Mensagens em JSON: `{ "op": <int>, "t": <string|null>, "s": <int|null>, "d": <payload> }`.
  - `op`: tipo de operação (dispatch, heartbeat, identify, resume, hello, ack).
  - `t`: nome do evento em dispatch (ex.: `MESSAGE_CREATE`).
  - `s`: número de sequência, usado no resume.
- Heartbeat em intervalo informado pelo servidor no `hello`; sem heartbeat, a conexão é encerrada.
- Resume: o cliente reenvia o último `s` e recebe os eventos perdidos de um buffer por sessão.
- Assinaturas por tópico: `user:<id>`, `guild:<id>`, `channel:<id>`.
- Os tipos de eventos e payloads ficam versionados em `packages/shared`.

Eventos mínimos: `READY`, `MESSAGE_CREATE`, `MESSAGE_UPDATE`, `MESSAGE_DELETE`, `TYPING_START`, `PRESENCE_UPDATE`, `GUILD_CREATE`, `GUILD_UPDATE`, `GUILD_DELETE`, `GUILD_MEMBER_ADD`, `GUILD_MEMBER_REMOVE`, `GUILD_MEMBER_UPDATE`, `CHANNEL_CREATE`, `CHANNEL_UPDATE`, `CHANNEL_DELETE`, `ROLE_CREATE`, `ROLE_UPDATE`, `ROLE_DELETE`, `VOICE_STATE_UPDATE`, `READ_STATE_UPDATE`.

### 5.4 Voz e vídeo

- O backend emite tokens do LiveKit; o nome da sala é o ID do canal.
- O LiveKit envia webhooks (`participant_joined`, `participant_left`, `track_published`…) ao backend.
- O backend mantém os voice states em memória e os distribui via `VOICE_STATE_UPDATE`.

### 5.5 Decisões de implementação

Decisões tomadas durante as fases, quando o SPEC deixava espaço. Cada item diz a fase em que entrou.

**Gerais (Fases 2 a 7)**
- IDs trafegam como string no JSON; erros seguem `application/problem+json` (huma). Recurso de servidor que o usuário não pode ver responde `404` (não vaza existência); falta de permissão em recurso visível responde `403`.
- As regras de permissão (bitflags, permissão efetiva, hierarquia) ficam em um pacote próprio, `server/internal/perm`, puro e sem dependências, usado pelos services.
- Services publicam eventos num barramento interno (`server/internal/platform/events`); só o pacote `gateway` converte eventos em mensagens WebSocket.
- Migrations só aditivas (o rollback de imagem não desfaz migrations).

**Fase 2 — Servidores, canais e mensagens (REST)**
- **Permissões (`internal/perm`).** Permissão efetiva = OR do `@everyone` com os cargos do membro; o dono e o ADMINISTRATOR têm todas (`perm.All`). O dono vale "posição infinita" na hierarquia e é isento dela. Cargos novos nascem na posição 1 (logo acima do `@everyone`, que é 0) e posições iguais são permitidas (empate); só se gerencia cargo com posição estritamente menor que a do seu cargo mais alto. "Só concede o que tem" vale para os bits *adicionados* (manter um bit que o cargo já tinha não conta), na criação, na edição e na atribuição a um membro. No `@everyone` só as permissões mudam (nome e posição não); ele nunca é excluído nem atribuído/removido de membros. O ADMINISTRATOR não escapa da hierarquia nem expulsa o dono.
- **Acesso por consulta única.** `GetMemberAccess` calcula dono, OR das permissões (`bit_or`) e posição mais alta numa query; é o caminho quente de toda autorização (`guild.Service.Member`). Os demais pacotes recebem `perm.Member` por uma interface própria (`Access`) e tratam `perm.ErrNotMember` como "recurso inexistente". Os canais não têm sobrescritas por cargo (fora do escopo): `VIEW_CHANNEL` é do servidor inteiro; membro sem ela recebe 403 nos canais e vê a lista de canais vazia em `GET /guilds/{id}`.
- **Erros.** Regras de negócio usam `internal/platform/apperr` (puro); só `platform/httpx` as traduz para HTTP: 404 (inexistente ou não-membro), 403 (sem permissão), 422 (dado inválido), 409 (conflito: limite de 100 servidores, dono tentando sair), 410 (convite expirado/esgotado), 429 (+ `Retry-After`).
- **Servidor.** Criação numa transação (servidor, `@everyone` com `id = guild_id`, categoria "Canais", `geral`, `Geral`, dono como membro). O limite de 100 servidores é checado sob lock na linha do usuário (`FOR NO KEY UPDATE`), o mesmo da entrada por convite, para não haver corrida. `GET /guilds` e `GET /guilds/{id}` devolvem o servidor completo (cargos do mais alto ao mais baixo, canais por posição, minhas permissões efetivas, `is_owner`, `my_role_ids`); a lista monta tudo em lote (sem N+1). Sair ou ser expulso = remover o membro (`DELETE /guilds/{id}/members/{user_id|@me}`); o dono sai só depois de `POST /guilds/{id}/transfer`. Excluir e transferir são só do dono (um membro com ADMINISTRATOR recebe 403). Ícone: `POST /guilds/{id}/icon` devolve URL pré-assinada (mesmo fluxo do avatar) e `PATCH` aceita só chaves `guild-icons/<id>/…`.
- **Canais.** Tipos 0, 1 e 2 apenas (DMs na Fase 4). Só categoria é pai; categoria não tem pai. Excluir uma categoria solta os filhos (`parent_id = NULL`) e emite `CHANNEL_UPDATE` para cada um. Reordenação em lote (`PATCH /guilds/{id}/channels/positions`) é atômica; `parent_id: null` tira o canal da categoria. Sem `position`, o canal novo vai ao final.
- **Convites.** Código de 8 caracteres de um alfabeto sem ambíguos (`0/O`, `1/l/I`), sorteado com `crypto/rand` (colisão: tenta de novo). `expires_in` em segundos (1 s a 30 dias), `max_uses` de 1 a 1.000.000. Entrar é uma transação: trava o usuário, **quem já é membro recebe 200 sem consumir uso (mesmo que o convite tenha expirado ou esgotado depois, para o clique duplo não virar erro)**, valida o limite de servidores e consome o uso com `UPDATE … WHERE uses < max_uses AND (expires_at IS NULL OR expires_at > now())` (atômico; N concorrentes disputando o último uso resultam em exatamente um sucesso). Convite expirado/esgotado responde 410 tanto em `GET` quanto em `POST`; inexistente, 404. Criar exige CREATE_INVITE; listar, MANAGE_GUILD; revogar, ser o criador ou ter MANAGE_GUILD.
- **Mensagens.** O conteúdo tem no máximo 2.000 *runes* (contadas no texto original) e não pode ser só espaços; é gravado sem os espaços das pontas. Anexos e mensagem vazia com anexo ficam para a Fase 6. Só canais de texto recebem mensagens. Enviar exige VIEW_CHANNEL + SEND_MESSAGES; ler/editar/excluir exigem VIEW_CHANNEL (sem um canal, mensagem apagada = 404). Só o autor edita (nem o dono); excluir é do autor ou de quem tem MANAGE_MESSAGES. Histórico: cursor `before` = ID da mensagem (Snowflake, que já ordena), `limit` 1–100 (padrão 50), ordem decrescente, `has_more` obtido pedindo `limit + 1` ao banco; a query usa o índice `(channel_id, id DESC)`. O INSERT, o autor (join) e o avanço de `channels.last_message_id` saem numa única ida ao banco (CTE). `created_at` na API vem do ID (`snowflake.Time`).
- **Rate limit de mensagens.** Token bucket em memória (5 de rajada, reposição de 1/s ≈ 5 por 5 s) com chave composta `msg:<usuário>:<canal>` (`ratelimit.Limiter.Take`), checado depois da autorização e antes de gravar; 429 com `Retry-After` em segundos (arredondado para cima). O estado é por processo (suficiente enquanto houver uma instância). O limite geral por IP (30 req/s, rajada de 90) foi mantido.
- **Eventos (`internal/platform/events`).** Barramento em memória: cada assinante tem uma fila de 256 eventos e uma goroutine; se a fila encher o evento é descartado para aquele assinante (log de aviso) e quem publica nunca bloqueia. Tópicos: `GUILD_CREATE` em `user:<id>` (com o servidor completo, no cadastro do servidor e na entrada por convite); `GUILD_UPDATE`, `GUILD_DELETE`, `GUILD_MEMBER_*`, `CHANNEL_*`, `ROLE_*` em `guild:<id>`; `MESSAGE_*` em `channel:<id>` (com `GuildID` e `ChannelID`). Quem sai ou é expulso também recebe `GUILD_DELETE` em `user:<id>` (o gateway usa para tirá-lo dos tópicos do servidor). Os payloads são os mesmos tipos da API (`*Payload`, JSON snake_case, IDs como string); `MESSAGE_DELETE` leva `{id, channel_id, guild_id}`. Os eventos são publicados depois do commit, sem garantia de entrega (o cliente refaz o GET ao reconectar).
- **Instrumentação.** `Server-Timing` ganhou a métrica `db` (soma do tempo das consultas da requisição, via `platform/db.Timed`); os services têm spans OpenTelemetry (`guild.*`, `channel.*`, `message.*`, `invite.*`; no envio há `message.authorize` e `message.insert`). Cenário k6: `bench/scenarios/messages.js` (+ `bench/scripts/seed-messages.sql`).
- **Teste de 1M de mensagens.** `TestPaginationWithOneMillionMessages` (integração) insere 1.000.000 de mensagens com `generate_series`, pagina com `limit=100` (10.000 páginas) enquanto outras mensagens chegam pela API e confere ausência de duplicatas e de buracos, ordem estrita e `has_more`. A latência da listagem (p50/p95/p99, HTTP local) é registrada no log do teste; a meta de 30 ms é informativa e não falha o teste.


**Fase 2 (front)**
- **Estado e cache.** A lista `GET /guilds` (servidor + canais + cargos + minhas permissões) é a fonte de verdade de toda a barra lateral; um servidor é um item dessa lista (`useGuild`). A lista é pré-carregada no `loader` da rota autenticada. Depois de cada mutação própria o app atualiza o cache (`setQueryData` para servidor novo, mensagens enviadas/editadas/excluídas) ou invalida a lista; não há polling. Todas as chaves ficam em `apps/web/src/lib/queryKeys.ts` e as operações sobre o histórico em `lib/message-cache.ts` (`addMessage`/`replaceMessage`/`removeMessage`): a Fase 3 pluga os eventos do gateway nesses pontos.
- **Permissões na interface.** `packages/shared/src/permissions.ts` traz as constantes (SPEC 7.2) e `hasPermission(efetivas, flag, {isOwner})` (dono e ADMINISTRATOR têm tudo). A interface só esconde ou desabilita ações (`lib/guild.ts` espelha a hierarquia: gerenciar cargo só abaixo do meu mais alto; expulsar não vale para o dono, para si mesmo nem para quem está no mesmo nível ou acima; bit de permissão que eu não tenho não pode ser ligado); a regra de verdade é do servidor e 403/404/409/410/422/429 viram mensagens em pt-br (`lib/app-errors.ts`).
- **Rotas.** `/` leva ao último servidor visitado (localStorage, só conveniência) ou ao primeiro; sem servidores mostra "Criar servidor"/"Entrar com convite". `/channels/$guildId` abre o último canal de texto visitado (ou o primeiro). `/invite/$code` fica na área autenticada: sem sessão redireciona para `/login?redirect=/invite/<código>` (só caminhos internos são aceitos em `redirect`; login e cadastro voltam para lá). Canais de voz aparecem na lista sem link (entrar é Fase 5).
- **Lista de mensagens.** TanStack Virtual com `anchorTo: "end"` e `followOnAppend` (a biblioteca ancora no fim, preserva a posição ao entrar página anterior e acompanha mensagem nova só se o usuário já estava no fim); `useInfiniteQuery` paginando por `before` = id da mais antiga (página de 50, `fetchNextPage({cancelRefetch:false})`); só rolagem para cima pede página (ignora os saltos de ancoragem). O componente usa `"use no memo"` (o virtualizer é mutável e não combina com o React Compiler) e as linhas são `memo` explícitos, com chave = id da mensagem. Mensagens do mesmo autor em até 7 minutos e no mesmo dia se agrupam; datas com date-fns (pt-BR). A mensagem própria sempre leva ao fim.
- **Composer.** Enter envia, Shift+Enter quebra linha (não envia durante composição IME); contador em runes (igual ao servidor); no 429 o `Retry-After` (agora exposto em `ApiError.retryAfter` pelo `http()` do shared) vira contagem regressiva e o texto é mantido.
- **`?perf=N` (só em dev).** Em `DEV`, `/channels/…/$canalId?perf=10000` troca o histórico por N mensagens falsas locais (`lib/perf.ts`), sem rede e sem composer; no build de produção o parâmetro é ignorado. Medição de referência (Chromium headless em Docker, rolando 120 px por quadro por 4 s com 10.000 mensagens): média de 16,5 ms por quadro, p95 16,7 ms, máximo 16,8 ms, ~28 mensagens no DOM. Os números definitivos ficam na Fase B.
- **Componentes.** shadcn escritos à mão em `components/ui` sobre Radix com versão exata (dialog, alert-dialog, dropdown-menu, tabs, tooltip, select, switch); configurações do servidor (`settings-dialog`) carregam sob demanda e o build separa `react`/`radix`/`vendor` em chunks.
- **E2E (RNF06).** `apps/web/e2e` (Playwright, Chromium) roda contra o build de produção servido pelo backend (`SPOOK_WEB_DIR`), com Postgres real e S3 desligado; no CI é o job `e2e` (o deploy já espera o CI inteiro por `uses: ./.github/workflows/ci.yml`). Localmente roda no container `mcr.microsoft.com/playwright` (comando em `apps/web/README.md`).
- **Ícone do servidor.** Mesmo fluxo do avatar (URL pré-assinada, PUT com `XMLHttpRequest` e progresso, depois `PATCH` com a chave; `icon_key: ""` remove).

**Fase 3 — Gateway realtime (backend)**
- **Endpoints.** `GET /api/gateway` (upgrade WebSocket, `coder/websocket`, sem compressão para poupar RAM/CPU) e `POST /api/gateway/ticket` (autenticado; fora do OpenAPI só o upgrade). Só o pacote `server/internal/gateway` conhece WebSocket; ele assina o barramento `platform/events` (fila do assinante do gateway: 4.096 eventos, ver abaixo) e consulta o domínio por uma interface própria (`Directory`: `List`, `Member`, `ChannelIDs`), implementada pelo `guild.Service`.
- **Autenticação no handshake, antes do upgrade (401 se falhar).** Ordem: `?ticket=<t>` (uso único, **30 s**, 24 bytes aleatórios, guardado em memória, no máximo 100.000 em aberto, 503 acima disso), `Authorization: Bearer`, cookie `spook_session`. O token **não** vai na query (vazaria em logs); o ticket existe porque o WebView do Tauri não manda headers no WebSocket. Origin: sem Origin passa (cliente que não é navegador); com Origin passa o próprio host do serviço, as de `SPOOK_ALLOWED_ORIGINS` (padrão `tauri://localhost,http://tauri.localhost`; a variável definida e vazia desliga as extras) e, em `development`, `localhost`/`127.0.0.1` em qualquer porta; senão 403. O handshake tem limite de IP próprio (50/s, rajada de 200), separado do geral de 30 req/s.
- **Protocolo.** Frame `{"op","t","s","d"}`. Ops: 0 dispatch, 1 heartbeat (cliente, `d` = último `s` ou null), 2 identify (`d` = `{client?}`; sem credenciais), 3 resume (`{session_id, seq}`), **9 invalid session** (servidor; `d: false`; decisão desta fase: depois do op 9 a conexão **continua aberta** e o cliente manda IDENTIFY nela, com mais 10 s), 10 hello (`{heartbeat_interval}` em ms), 11 ack (`d: null`). Fluxo: HELLO → IDENTIFY (até **10 s**, senão fecha 4006) → dispatch READY (`s = 1`) `{session_id, user:{id}, guilds:[…]}`, com `guilds` no formato do `GET /api/guilds` (canais vazios sem VIEW_CHANNEL). `heartbeat_interval` = **41 s** (abaixo do corte de 100 s ociosos do Cloudflare); sem heartbeat em **1,5×** o intervalo (61,5 s) fecha com 4009. `s` cresce de 1 em 1 por sessão; **RESUMED** é dispatch com `s = null` (não consome sequência) e `d = {session_id, replayed}`, enviado depois dos eventos reenviados.
- **Códigos de fechamento.** 1001 shutdown do servidor (reconectar e fazer resume); 4000 frame inválido; 4001 op inválido; 4002 sessão retomada por outra conexão; 4003 op antes do IDENTIFY; 4005 IDENTIFY/RESUME repetido; 4006 sem IDENTIFY em 10 s; **4008 consumidor lento** (a sessão é mantida); 4009 sem heartbeat (sessão mantida); 4029 mais de **120 ops por minuto** por conexão (token bucket, rajada de 120) ou limite de sessões. O cliente reconecta em todos; com 4002 não deve (outra conexão é a dona).
- **Resume (RNF07).** A sessão vive **60 s** depois da queda do socket. Buffer circular por sessão de **512 eventos** e **60 s** de idade (o que estourar primeiro); o payload é compartilhado entre as sessões (só o cabeçalho é por sessão). Resume válido exige `seq` coberto pelo buffer, sessão viva e **mesmo usuário** do handshake; senão op 9. Reconectar com a sessão ainda presa a outro socket derruba o antigo (4002). Máximo de **20 sessões por usuário** (as sem socket mais antigas saem primeiro; se todas têm socket, o IDENTIFY novo é recusado com 4029). A janitor roda a cada min(5 s, janela/4).
- **Fan-out e permissão.** Tópicos `user:<id>`, `guild:<id>`, `channel:<id>`. No IDENTIFY a sessão assina o próprio `user:`, cada `guild:` e os `channel:` dos canais que **pode ver**. Manutenção: `GUILD_CREATE` (tópico do usuário) assina o servidor novo; `GUILD_DELETE` entrega e depois desassina; `CHANNEL_CREATE/DELETE` assinam/desassinam o canal; `ROLE_UPDATE/ROLE_DELETE` (todas as sessões do servidor) e `GUILD_MEMBER_UPDATE` (só as sessões do usuário alvo) **recalculam a permissão antes de entregar** o evento (`Directory.Member`, em paralelo limitado a 16, uma consulta por usuário); perdeu VIEW_CHANNEL → sai de todos os canais; ganhou → busca `ChannelIDs` e entra. `ROLE_CREATE` não recalcula (cargo novo não tem membros). Defesa em profundidade: `MESSAGE_*` e `CHANNEL_*` de um servidor só são entregues se a sessão ainda tem VIEW_CHANNEL nele, mesmo com a assinatura viva. Eventos de servidor sem canal vão a todos do `guild:<id>`, com ou sem VIEW_CHANNEL (as permissões de canal são do servidor inteiro, ver Fase 2). Janela conhecida: eventos publicados entre a consulta do READY e a assinatura são perdidos (o cliente refaz o GET ao reconectar, como na Fase 2).
- **Backpressure.** Não há fila separada: o escritor da conexão lê do próprio buffer da sessão. Se `s_atual − último_s_escrito` passar de **256** (consumidor lento: o TCP encheu e o escritor travou), a conexão é fechada com 4008 e a sessão fica para o resume; escrita no socket tem timeout de 10 s. `push` nunca bloqueia (quem publica e as demais sessões não são afetados). O bus do app passa a ter fila de **4.096** eventos (era 256) por ser um assinante só que recebe todos os eventos em rajada. Encerramento: ao cancelar o contexto (SIGTERM) ou `Hub.Shutdown`, todas as conexões recebem close **1001** e novos handshakes viram 503; o `main` espera o gateway terminar antes de `srv.Shutdown` (conexões hijacked não são esperadas pelo `http.Server`).
- **Eventos.** Todos os payloads são tipos exportados de JSON snake_case: os das features (`MESSAGE_*`, `GUILD_*`, `CHANNEL_*`, `ROLE_*`, `GUILD_MEMBER_*`) e, no pacote `gateway`, `Hello`, `Identify`, `Resume`, `Ready`, `Resumed`, `TypingStart {channel_id, guild_id, user_id, timestamp}`, `PresenceUpdate {user_id, status: online|idle|offline}`, `VoiceStateUpdate {guild_id, channel_id (null = saiu), user_id, self_mute, self_deaf, self_video, self_screen}` e `ReadStateUpdate {channel_id, last_read_message_id, mention_count}` (estes quatro só serão emitidos nas Fases 4 a 6; o contrato já está fixo). O arquivo `packages/shared/fixtures/gateway-events.json` (um exemplo de cada frame e dos códigos de fechamento) é gerado e conferido por `TestGatewayEventsFixtures` (`go test ./internal/gateway -run Fixtures -update` regrava); o front o valida com Zod.
- **Instrumentação.** `events.Event` ganhou `At` (o Bus preenche). `platform/telemetry` passou a configurar também o `MeterProvider` OTLP (mesmo endpoint, exporta a cada 15 s; no-op sem endpoint) e as métricas de runtime do Go. Métricas: `spook.gateway.connections` e `.sessions` (gauges), `.events.dispatched` (por tipo), `.resumes`, `.invalid_sessions`, `.slow_consumer_closes`, `.identify.duration` e `.publish_to_write.duration` (histograma, s). Spans: `gateway.connection` (vida da conexão), `gateway.identify`, `gateway.resume`, `gateway.fanout` (por evento, com destinatários) e `gateway.refresh_permissions`. O coletor de dev ganhou um pipeline de métricas (exporter Prometheus em `:8889`). Cenários k6: `bench/scenarios/gateway-connections.js` e `gateway-latency.js` (receita de "conexões por GB de RAM" em `bench/README.md`).
- **Testes.** `scripts/go.sh` passou a montar a raiz do repositório no container (os testes do fixture escrevem em `packages/shared`). Unitários do gateway rodam o servidor real atrás de `servertiming` e `otelhttp` (prova que o upgrade passa por eles) com um `Directory` falso; os de integração (`app/gateway_integration_test.go`, tag `integration`) usam Postgres e cliente WebSocket real.

**Fase 3 (front)**
- **Cliente (`packages/shared/src/gateway`).** `GatewayClient` é agnóstico de React e de ambiente: `socketFactory` e `getTicket` são injetáveis (a web usa o cookie, sem ticket; o desktop passa um `getTicket` que chama `POST /api/gateway/ticket` a cada conexão). Os schemas Zod de todos os frames e payloads (`schemas.ts`) são a fonte dos tipos de evento; `contract.test.ts` valida cada exemplo de `fixtures/gateway-events.json` (um teste por evento, mais os frames de controle e os `close_codes`). Estado observável `connecting | connected | reconnecting | closed`; `connected` só depois de READY/RESUMED. Os testes usam `FakeSocket` (`@spook/shared/testing`) e relógio falso.
- **Reconexão.** Backoff exponencial de 1 s a 30 s com "equal jitter" (metade fixa, metade aleatória), zerado quando o READY ou o RESUMED chega (e não quando o socket abre, para um servidor que abre e fecha logo não virar laço apertado); 4029 espera no mínimo 5 s. Reconecta em todo fechamento, exceto **4002** (outra conexão é a dona da sessão: o cliente fica `closed` com erro `taken_over`). Falha ao obter o ticket: 401/403 encerra (erro `auth`), qualquer outra reconecta com backoff. O navegador não mostra o status HTTP de um handshake recusado (vira fechamento 1006), então um 401 no cookie da web reconecta em backoff de até 30 s até a guarda de sessão (`useSessionGuard`, que reage ao 401 das demais requisições) mandar ao login.
- **Heartbeat.** O primeiro sai em `random × intervalo` (jitter), os demais a cada intervalo (41 s). Cada heartbeat arma um prazo de 15 s para o ack; sem ele a conexão é considerada morta, derrubada e retomada (não espera o servidor fechar com 4009). `reconnectNow()` (aba visível, evento `online`) sai do backoff na hora ou, se parece conectado, sonda com um heartbeat; `notifyOffline()` (evento `offline`) derruba o socket sem esperar. Sem HELLO em 15 s depois de abrir, derruba e tenta de novo.
- **Ordem e `onInvalidated`.** Dispatch com `s` menor ou igual ao último é descartado (duplicado/antigo); `s` com buraco entrega o evento e chama `onInvalidated`; evento desconhecido avança a sequência e é ignorado; payload inválido vira erro `protocol` sem derrubar a conexão. `onInvalidated` também dispara quando um READY chega depois de uma sessão anterior (op 9 ou sessão expirada): é o aviso para refazer os GETs. O op 9 faz o IDENTIFY na mesma conexão, imediatamente.
- **Web (`apps/web/src/features/gateway`).** `GatewayProvider` (no layout autenticado) conecta ao montar e fecha (1000) ao desmontar (logout); reconecta ao voltar a internet ou a aba. Estado em Zustand (`store.ts`: status, `sessionId`, `userId` do READY, último erro, `retry`). `cache-bindings.ts` liga os eventos ao cache pelos pontos de plug da Fase 2 (`message-cache`, `guild-cache` e o novo `member-cache`): a mensagem própria não duplica porque `addMessage` deduplica por id (vale na ordem POST→evento e evento→POST). O **READY** substitui a lista de servidores pelo que o servidor mandou e refaz os históricos abertos (fecha a janela entre o GET e a assinatura); uma **sessão nova depois de uma antiga (op 9 ou sessão expirada)** invalida servidores, todos os históricos (os inativos ficam velhos e refazem ao abrir) e membros; o **resume** não faz GET nenhum. `MESSAGE_*` que chega com um GET do histórico em andamento refaz o GET (a resposta pode ter sido gerada antes do evento).
- **Permissões (o servidor não avisa "canais visíveis mudaram").** `GUILD_MEMBER_UPDATE` do próprio usuário, `ROLE_UPDATE` de cargo meu ou do `@everyone`, `ROLE_DELETE` de cargo meu e `GUILD_UPDATE` que troca dono ou ícone invalidam a lista de servidores; com a lista nova o app confere o lugar atual: se o canal aberto sumiu (excluído ou sem VIEW_CHANNEL) leva a `/channels/$guildId` com um aviso, se o servidor sumiu leva a `/`. `GUILD_DELETE` e `GUILD_MEMBER_REMOVE` do próprio usuário saem do servidor do mesmo jeito (o eco de quem saiu pelo app não repete o aviso). Eventos de cargo e de membro também atualizam o cache de cargos e de membros (se já carregados).
- **Indicador de conexão.** "Reconectando…" só aparece depois de 2,5 s em `reconnecting` (quedas curtas e resumes rápidos passam sem piscar); sessão tomada por outra conexão (4002) mostra "Sessão aberta em outro lugar" com o botão "Reconectar" (sessão nova, tudo refeito). Nenhum polling.
- **Eventos sem UI.** `TYPING_START`, `PRESENCE_UPDATE`, `VOICE_STATE_UPDATE` e `READ_STATE_UPDATE` são tipados e validados, mas ignorados no cache até as Fases 4 a 6.
- **Testes.** Unitários do cliente (backoff, heartbeat/ack, resume com `seq`, op 9, 4002, ordem/dedup, ticket), do store, do indicador e de `cache-bindings`; integração com o app inteiro e WebSocket falso (`src/gateway.test.tsx`; o MSW troca o `WebSocket` global, então o falso entra por `setGatewaySocketFactory`). E2E (`e2e/gateway.spec.ts`, backend real): A envia e B vê sem recarregar; B fica offline (`context.setOffline`), A envia, B volta e recebe pelo RESUMED sem READY novo; A tira VIEW_CHANNEL do `@everyone`, B é levado para fora do canal e não recebe mais nada.
- **Tipos.** O `tsconfig` do web ficou sem `baseUrl` (o `paths` basta; o TypeScript 6, que o pnpm resolve para o web, recusa `baseUrl`).

**Fase 4 — Presença, "digitando…" e DMs (backend)**
- **Presença (`internal/presence`), só em memória.** O gateway avisa por uma interface própria (`Presence`: `Connect`, `Disconnect`, `SetIdle`, `Snapshot`) implementada por `presence.Service`. Conta como sessão ativa a **sessão com socket** (não a sessão em janela de resume): `Connect` ao IDENTIFY/RESUME, `Disconnect` quando o socket cai (chamados sob o lock da sessão, para a ordem ficar certa). Status do usuário = o melhor entre as sessões (online > idle). **Offline só 15 s depois que a última sessão cai** (`presence.Config.OfflineGrace`, configurável em `Deps.Presence`); reconectar dentro do prazo, mesmo com sessão nova, não gera evento (durante a tolerância o status publicado segue o último). Perder a sessão ativa e sobrar só uma ausente publica `idle` na hora (só o offline espera). As transições são enfileiradas sob o lock (ordem por usuário garantida) e publicadas por filas em segundo plano, que consultam o banco: `PRESENCE_UPDATE {user_id, status}` em `guild:<id>` de cada servidor do usuário e em `user:<par>` de cada par de DM (1:1 ou grupo).
- **Op 12 (`PRESENCE_UPDATE`, cliente → servidor).** `d = {"status": "online"|"idle"}`; vale para a sessão que enviou, conta no limite de 120 ops/min e exige IDENTIFY antes (4003). Status inválido fecha com 4000. O "ausente após 10 min sem interação" é medido **pelo cliente** (o servidor não vê interação); o servidor só guarda o que o cliente sinaliza. Uma sessão nova começa "online".
- **Snapshot no READY.** `presences: [{user_id, status}]` só com online/idle (offline não entra), de quem compartilha servidor ou DM com quem conectou, sem o próprio usuário. Calculado cruzando o conjunto de online (memória) com o banco a partir dos servidores e DMs do próprio usuário (índice `(guild_id, user_id)`), sem varrer membros de servidores grandes. Falha na consulta não derruba o READY (sai `[]` com aviso no log). Janela conhecida, como nas demais fases: eventos entre o snapshot e a assinatura se perdem.
- **Presença e membros/DMs novos.** Quem entra num servidor (`GUILD_MEMBER_ADD`) e está online publica o próprio status em `guild:<id>` e recebe, como `PRESENCE_UPDATE` individuais em `user:<ele>`, quem está online no servidor (até 500). Em DM em grupo (criação ou participante adicionado) os participantes online passam a se ver por `user:<par>`, já que podem não dividir servidor; a DM 1:1 não faz isso (o par já se vê pelo servidor em comum).
- **"Digitando…" (`internal/typing`).** `POST /api/channels/{id}/typing` (204): exige poder escrever no canal (VIEW_CHANNEL + SEND_MESSAGES) ou ser participante da DM (404 para quem não vê, 403 para sem permissão, 422 em canal de voz/categoria). Publica `TYPING_START {channel_id, guild_id|null, user_id, timestamp}` em `channel:<id>`. Throttle no servidor: no máximo **1 evento por usuário e canal a cada 3 s** (token bucket 1/1 em `ratelimit.Limiter`); o excedente é ignorado e também responde 204. O fim ("expira após 8 s sem novo evento") é do cliente; o remetente também recebe o próprio evento (o cliente ignora o que for dele). O filtro de VIEW_CHANNEL do gateway vale para `TYPING_START`.
- **Tabelas (migration `00004_dms.sql`, aditiva).** `channel_recipients(channel_id, user_id)` (PK composta, índice por `user_id`) e `dm_pairs(user_a, user_b, channel_id)` com `CHECK (user_a < user_b)` e PK no par: a unicidade da DM 1:1 vale sob corrida porque `OpenPair` cria o canal e reserva o par na mesma transação com `INSERT … ON CONFLICT DO NOTHING`; quem perde descarta o canal e devolve o vencedor (200). A DM em grupo não usa `dm_pairs`.
- **Regras de DM (`internal/dm`).** `POST /api/users/@me/channels` com `recipient_id` (1:1) **ou** `recipient_ids` (grupo), nunca os dois (422): 1:1 devolve 201 ao criar e 200 se já existia (para qualquer dos dois lados); exige servidor em comum (403, inclusive para usuário inexistente, para não vazar existência) e proíbe DM consigo mesmo (422). Grupo: 1 a 9 convidados (dono + convidados ≤ 10; mais que isso 422), duplicados contam uma vez, o dono não entra na lista (422), cada convidado precisa dividir servidor **com o dono** (403). Criação de DM (1:1 ou grupo) limitada a **10 por minuto por usuário** (429 + `Retry-After`), checada antes de tocar o banco. `PUT /api/channels/{id}/recipients/{user_id}` (só o dono: 403 para participante, 404 para quem não participa; convidado precisa dividir servidor com o dono; 409 acima de 10, com `FOR NO KEY UPDATE` no canal para a contagem valer sob corrida; adicionar quem já está é 200 sem eventos). `DELETE …/recipients/{user_id|@me}` (204): o dono remove qualquer um e cada participante sai; **o dono não é removível e não sai (409)**; só quem é dono remove outro (403); quem já saiu é 404. DM 1:1 não tem participantes a mudar, nome nem posição (422). `PATCH /api/channels/{id}` em DM em grupo renomeia (só o dono; 1 a 100 caracteres) e em canal de servidor segue as regras de antes. `DELETE /api/channels/{id}` não se aplica a DM (404). `GET /api/users/@me/channels` lista as DMs do usuário com participantes e `last_message_id`, da atividade mais recente (`COALESCE(last_message_id, id)` desc) para a mais antiga.
- **Payload de canal em DM.** O mesmo `ChannelPayload` ganha, só em DMs, `owner_id` (grupo) e `recipients: [{id, username, display_name?, avatar_url?}]` com **todos** os participantes (inclusive quem consulta e o dono), ordenados por id; `name` é `""` na 1:1 e `guild_id` é `null`.
- **Mensagens em DM.** Mesmos endpoints e rate limit (5 a cada 5 s por usuário e canal). `channel.Service.Authorize` passou a cobrir DMs por uma interface própria (`DMs.IsRecipient`, implementada por `dm.Service` e ligada na montagem): participante passa (sem cargos; o `perm.Member` volta vazio e `ch.GuildID` é nil), quem não participa recebe 404. Em DM só o autor edita **e** exclui (não há MANAGE_MESSAGES) e o histórico inteiro fica visível a quem participa, inclusive a quem entra depois. `MESSAGE_DELETE` omite `guild_id` em DMs. Todos os tipos de canal que aceitam mensagens: texto, DM e DM em grupo.
- **Eventos de DM.** Criação: um `CHANNEL_CREATE` com os tópicos `user:<id>` de todos os participantes. Adicionar participante: `CHANNEL_CREATE` só para o novo (para o gateway assiná-lo) e `CHANNEL_UPDATE` com a lista nova para os demais. Remover/sair: `CHANNEL_DELETE` para quem saiu e `CHANNEL_UPDATE` com a lista nova para os que ficam. Renomear: `CHANNEL_UPDATE` para todos. `MESSAGE_*` e `TYPING_START` seguem em `channel:<id>`. Todos são publicados depois do commit, sem garantia de entrega (como antes).
- **Gateway e DMs.** O READY ganha `private_channels` (as DMs com participantes, mesmo formato de `GET /api/users/@me/channels`) e `presences`; ambos sempre arrays (`[]`, nunca `null`). No IDENTIFY a sessão assina `channel:<id>` de cada DM; `CHANNEL_CREATE` ou `CHANNEL_UPDATE` de DM em `user:<id>` assina o canal (idempotente, vale também para outras sessões do mesmo usuário), e `CHANNEL_DELETE` o cancela depois de entregar: quem foi removido não recebe mais mensagens (os eventos do barramento são processados em ordem, então o cancelamento vem antes de qualquer mensagem publicada depois da remoção). Falha em listar as DMs derruba o IDENTIFY (como a lista de servidores). `NewHub` aceita opções (`WithDMs`, `WithPresence`); sem elas o gateway da Fase 3 funciona igual (arrays vazios no READY).
- **Payloads.** `TYPING_START` e `PRESENCE_UPDATE` passaram a ter os tipos nos pacotes que os emitem (`typing.StartPayload`, `presence.UpdatePayload`) em vez do `gateway` (o JSON é o mesmo da Fase 3). O arquivo `gateway-events.json` ganhou `ready` com `private_channels`/`presences`, `set_presence` (frame do op 12) e `dm_channel_create` (CHANNEL_CREATE de DM em grupo).
- **Instrumentação.** Métricas: `spook.presence.users{status}` (gauge online/idle), `spook.presence.transitions{status}` (contador), `spook.typing.started` (contador, depois do throttle) e `spook.dm.created{kind=dm|group}` (contador). Spans: `presence.transition` (por transição, com o número de tópicos), `presence.member_joined`, `presence.snapshot`, `typing.Start`, `dm.Open`/`CreateGroup`/`AddRecipient`/`RemoveRecipient`/`Rename`/`List`. Cenário k6 `bench/scenarios/gateway-fanout.js` (N sockets no mesmo canal e poucos remetentes a taxa fixa: entregas/s, perdas e latência); a execução fica para a Fase B.
- **Testes.** Unitários: máquina de estados da presença com relógio falso (tolerância de 15 s, idle, várias sessões, reconexão sem evento, snapshot, entrada em servidor, DM em grupo), throttle do typing, regras de DM com fakes (servidor em comum, limite de 10, só o dono, par único e corrida), `Authorize`/`Update` de DM e mensagens em DM, gateway com fakes (op 12, assinaturas de DM, READY). Integração (`app/phase4_integration_test.go`, cliente WebSocket real): presença entre quem compartilha e quem não compartilha, tolerância, reconexão rápida, várias abas, idle via op 12, visibilidade por DM em grupo, READY com `presences`/`private_channels`, typing (throttle, 404/403/422), DM 1:1 (par único sob corrida de 12 requisições, 404 para não participante, servidor em comum), DM em grupo (limite, só o dono, saída, renomear, removido sem mensagens), corrida de adições no limite de 10 e regressão das mensagens de servidor. Em testes, `Deps.AuthLimiter`, `Deps.DMLimiter`, `Deps.TypingLimiter` e `Deps.Presence` ajustam limites e tempos.

---

## 6. Modelo de dados

IDs são Snowflake (`bigint`) salvo indicação contrária. Timestamps em `timestamptz`.

### users
| Coluna | Tipo | Notas |
| --- | --- | --- |
| id | bigint PK | |
| email | citext UNIQUE | |
| username | citext UNIQUE | 2–32 caracteres, `[a-z0-9_.]` |
| display_name | text NULL | até 32 caracteres |
| password_hash | text | Argon2id |
| avatar_key | text NULL | chave no storage |
| created_at | timestamptz | |

### sessions
| Coluna | Tipo | Notas |
| --- | --- | --- |
| id | bigint PK | |
| user_id | bigint FK users | |
| token_hash | bytea UNIQUE | hash do token; o token puro nunca é salvo |
| user_agent | text NULL | |
| expires_at | timestamptz | |
| created_at | timestamptz | |

### guilds
| Coluna | Tipo | Notas |
| --- | --- | --- |
| id | bigint PK | |
| name | text | 2–100 caracteres |
| icon_key | text NULL | |
| owner_id | bigint FK users | |
| created_at | timestamptz | |

### guild_members
| Coluna | Tipo | Notas |
| --- | --- | --- |
| guild_id | bigint FK guilds | PK composta |
| user_id | bigint FK users | PK composta |
| nickname | text NULL | |
| joined_at | timestamptz | |

### roles
| Coluna | Tipo | Notas |
| --- | --- | --- |
| id | bigint PK | o `@everyone` tem `id = guild_id` |
| guild_id | bigint FK guilds | |
| name | text | |
| color | int NULL | RGB |
| position | int | maior = mais alto na hierarquia |
| permissions | bigint | bitflags (ver 7.2) |

### member_roles
| Coluna | Tipo | Notas |
| --- | --- | --- |
| guild_id, user_id | bigint | FK para guild_members; PK composta com role_id |
| role_id | bigint FK roles | |

### channels
| Coluna | Tipo | Notas |
| --- | --- | --- |
| id | bigint PK | |
| type | smallint | 0 texto, 1 voz, 2 categoria, 3 DM, 4 DM em grupo |
| guild_id | bigint NULL FK guilds | NULL em DMs |
| parent_id | bigint NULL FK channels | categoria |
| name | text NULL | NULL em DM 1:1 |
| position | int | |
| owner_id | bigint NULL FK users | dono da DM em grupo |
| last_message_id | bigint NULL | para não lidas |
| created_at | timestamptz | |

### channel_recipients (DMs)
| Coluna | Tipo | Notas |
| --- | --- | --- |
| channel_id | bigint FK channels | PK composta |
| user_id | bigint FK users | PK composta |

### messages
| Coluna | Tipo | Notas |
| --- | --- | --- |
| id | bigint PK | Snowflake, define a ordem |
| channel_id | bigint FK channels | |
| author_id | bigint FK users | |
| content | text | até 2.000 caracteres |
| edited_at | timestamptz NULL | |
| deleted_at | timestamptz NULL | soft delete |

Índice principal: `(channel_id, id DESC)`.

### attachments
| Coluna | Tipo | Notas |
| --- | --- | --- |
| id | bigint PK | |
| message_id | bigint NULL FK messages | NULL até a mensagem ser enviada |
| uploader_id | bigint FK users | |
| object_key | text | chave no storage |
| filename | text | |
| content_type | text | |
| size_bytes | bigint | |
| width, height | int NULL | imagens |
| thumbnail_key | text NULL | preenchido pelo job |
| created_at | timestamptz | |

### invites
| Coluna | Tipo | Notas |
| --- | --- | --- |
| code | text PK | 8 caracteres aleatórios |
| guild_id | bigint FK guilds | |
| creator_id | bigint FK users | |
| max_uses | int NULL | NULL = ilimitado |
| uses | int | |
| expires_at | timestamptz NULL | NULL = não expira |
| created_at | timestamptz | |

### read_states
| Coluna | Tipo | Notas |
| --- | --- | --- |
| user_id | bigint FK users | PK composta |
| channel_id | bigint FK channels | PK composta |
| last_read_message_id | bigint | |
| mention_count | int | |

### push_subscriptions
| Coluna | Tipo | Notas |
| --- | --- | --- |
| id | bigint PK | |
| user_id | bigint FK users | |
| endpoint | text UNIQUE | Web Push |
| p256dh, auth | text | chaves da inscrição |
| created_at | timestamptz | |

### Estado só em memória (não persistido)
- Presença e sessões do gateway
- Indicadores de "digitando"
- Voice states (reconstruídos a partir dos webhooks do LiveKit)

---

## 7. Regras de negócio

### 7.1 Servidores e membros
- O criador do servidor é o dono e recebe todas as permissões implicitamente.
- O dono não pode sair sem antes transferir a posse; ele pode excluir o servidor.
- Um usuário pode estar em no máximo 100 servidores.
- Um servidor nasce com o cargo `@everyone`, uma categoria, um canal de texto `geral` e um canal de voz `Geral`.

### 7.2 Permissões (bitflags)

| Bit | Permissão |
| --- | --- |
| 1 << 0 | ADMINISTRATOR (todas as permissões) |
| 1 << 1 | MANAGE_GUILD |
| 1 << 2 | MANAGE_CHANNELS |
| 1 << 3 | MANAGE_ROLES |
| 1 << 4 | KICK_MEMBERS |
| 1 << 5 | CREATE_INVITE |
| 1 << 6 | VIEW_CHANNEL |
| 1 << 7 | SEND_MESSAGES |
| 1 << 8 | MANAGE_MESSAGES |
| 1 << 9 | ATTACH_FILES |
| 1 << 10 | CONNECT (voz) |
| 1 << 11 | SPEAK |
| 1 << 12 | VIDEO (câmera e tela) |

- Permissão efetiva = OR das permissões de `@everyone` e de todos os cargos do membro.
- Permissões padrão do `@everyone`: VIEW_CHANNEL, SEND_MESSAGES, ATTACH_FILES, CREATE_INVITE, CONNECT, SPEAK, VIDEO.
- Um membro só gerencia cargos com posição menor que o seu cargo mais alto, e só concede permissões que ele mesmo tem.
- Um membro só expulsa quem tem cargo mais alto menor que o seu. O dono nunca pode ser expulso.

### 7.3 Mensagens
- Conteúdo de 1 a 2.000 caracteres, ou vazio se houver anexo.
- Até 10 anexos por mensagem, com no máximo 25 MB cada.
- Só o autor edita a mensagem.
- O autor ou quem tem MANAGE_MESSAGES pode excluí-la.
- Exclusão é soft delete; o conteúdo some para os clientes imediatamente.
- Rate limit: 5 mensagens a cada 5 segundos por usuário e canal.

### 7.4 DMs
- DM 1:1 só entre usuários que compartilham pelo menos um servidor.
- A DM 1:1 entre dois usuários é única; reabrir retorna a existente.
- DM em grupo tem no máximo 10 participantes; só o dono adiciona ou remove.

### 7.5 Convites
- Um convite expirado ou que atingiu `max_uses` é inválido.
- Usuários que já são membros não consomem uso.

### 7.6 Presença
- Online quando há ao menos uma sessão de gateway ativa.
- Ausente após 10 minutos sem interação, sinalizado pelo cliente.
- Offline quando a última sessão cai, após 15 segundos de tolerância (evita oscilação em reconexões).
- "Digitando" expira após 8 segundos sem novo evento.

### 7.7 Voz
- Um usuário está em no máximo um canal de voz por vez; entrar em outro sai do anterior.
- Tokens do LiveKit valem 10 minutos e só para a sala do canal.
- Entrar exige CONNECT; falar exige SPEAK; câmera e tela exigem VIDEO.

### 7.8 Notificações
- Não lidas = mensagens com ID maior que `last_read_message_id`.
- Web push só é enviado se o usuário não tiver sessão de gateway ativa.
- Push apenas para DMs e menções diretas.

---

## 8. Critérios de aceite por fase

Cada fase só é concluída quando todos os critérios forem atendidos **e** a instrumentação da fase (header `Server-Timing`, métricas e traces no código) e os cenários k6 correspondentes estiverem escritos e versionados em `bench/`. A **execução** das medições e o registro dos resultados ficam na **Fase B**, depois da Fase 7.

Os critérios marcados com `[x]` foram verificados. Os que dependem de validação manual (voz com outra pessoa, app desktop, permissões do navegador etc.) ficam desmarcados e listados em `VALIDACAO-MANUAL.md`.

### Fase 0 — Fundação
- [x] `pnpm dev` sobe web, backend, Postgres, Garage e LiveKit localmente com um comando.
- [x] CI roda lint (golangci-lint e Biome), testes e build com sucesso.
- [x] Traces de uma requisição aparecem no Grafana.
- [x] O baseline k6 do Laravel está registrado.

### Fase 1 — Auth, usuários e deploy no VPS
Entrega o deploy em produção, no padrão do VPS (RNF05): Docker Compose de produção em `deploy/`, rodando como o usuário `spook` com Docker rootless; entrada por container `cloudflared` com túnel próprio para `spook.dottadigital.com`, `spook-rtc.dottadigital.com` e `spook-files.dottadigital.com`; mídia do LiveKit direto no IP público; imagens buildadas no CI e publicadas no GHCR (sem build no VPS); segredos fora do git; e deploy reproduzível por GitHub Actions via SSH (push na `main` e `workflow_dispatch`). A preparação única do servidor fica documentada em `deploy/README.md`.

- [x] Usuário se cadastra, faz login, edita o perfil e faz logout.
- [x] Rotas protegidas retornam 401 sem autenticação.
- [x] Client TypeScript gerado a partir do OpenAPI e usado pelo front.
- [x] Deploy reproduzível no VPS (GitHub Actions por SSH, Docker rootless, imagens do GHCR), com os três domínios acessíveis pelo túnel e segredos fora do repositório.
- [x] `https://spook.dottadigital.com/healthz` responde ok em produção.
- [x] O cenário k6 do baseline (Fase 0) roda contra o Spook em produção, com o resultado registrado em `bench/results/` ao lado do baseline do Laravel.

### Fase 2 — Servidores, canais e mensagens (REST)
- [x] Todos os RF02 a RF06 funcionam via REST, com as regras da seção 7 aplicadas e testadas.
- [x] Paginação por cursor retorna páginas consistentes com 1M de mensagens no banco.

### Fase 3 — Gateway realtime
- [x] Mensagem enviada aparece nos outros clientes sem recarregar a página.
- [x] Derrubar a conexão e reconectar recupera os eventos perdidos (resume).
- [x] Usuário sem VIEW_CHANNEL não recebe eventos daquele canal.

### Fase 4 — Presença e DMs
- [ ] Status muda em tempo real para os demais usuários.
- [ ] "Digitando…" aparece e expira corretamente.
- [ ] DMs 1:1 e em grupo funcionam com as regras da seção 7.4.

### Fase 5 — Voz, vídeo e tela (web)
- [ ] Dois usuários conversam por voz num canal; um compartilha a tela e o outro vê.
- [ ] A lista de participantes do canal de voz atualiza em tempo real para todo o servidor.
- [ ] Permissões CONNECT, SPEAK e VIDEO são respeitadas.

### Fase 6 — Uploads e notificações
- [ ] Upload de imagem gera thumbnail e aparece na mensagem.
- [ ] Arquivos acima do limite ou de tipo inválido são rejeitados.
- [ ] Contagem de não lidas é correta após ler e ao receber novas mensagens.
- [ ] Web push chega quando o usuário está offline.

### Fase 7 — Desktop
- [ ] O app Tauri roda no Windows, macOS e Linux com todas as funcionalidades da web.
- [ ] Voz e compartilhamento de tela funcionam no Linux e no macOS via captura nativa.
- [ ] Versão liberada para usuários e canal de feedback definido.

### Fase B — Benchmarks e observabilidade
Reúne tudo que mede e observa, executado depois da Fase 7 (as fases só entregam a instrumentação e os cenários k6 versionados). As medições são feitas contra produção no VPS, nos dois tipos lado a lado (internet e interno, RNF03).

**Observabilidade em produção:** Grafana Cloud (plano gratuito), com apenas um coletor OpenTelemetry leve no VPS enviando traces, métricas e logs. Prometheus, Loki e Grafana não rodam no VPS, para não pesar no servidor nem distorcer os benchmarks (o dev local continua com Tempo e Grafana via Compose). Até lá, o backend em produção roda com OTLP desligado.

- [ ] Traces e métricas do backend em produção chegam ao Grafana Cloud via coletor OpenTelemetry no VPS.
- [ ] Medições internas pendentes da Fase 1 rodadas e registradas: `run-internal.sh` (healthz e `me.js` nos dois sistemas) e o `Server-Timing` do Spook em produção, em `bench/results/`.
- [ ] Fase 1: p95 de login e RAM ociosa do backend (já registrados em 30/10/2026 pela internet; repetir com o `Server-Timing` e a medição interna).
- [ ] Fase 2: p95 de listar e enviar mensagens.
- [ ] Fase 3: latência ponta a ponta p50/p95/p99 e conexões por GB de RAM, Spook vs Laravel Reverb.
- [ ] Fase 4: CPU e mensagens/s com N usuários conectados.
- [ ] Fase 5: CPU e banda do VPS por participante; jitter, perda e RTT.
- [ ] Fase 6: throughput de upload e tempo do job de thumbnail.
- [ ] Fase 7: RAM ociosa, RAM em call, tamanho do instalador e tempo de boot, Tauri vs Electron.

---

## 9. Identidade visual

Fonte: a ficha `packages/brand/Spook-identidade-visual.pdf` e os arquivos em `packages/brand/assets/`. Em caso de divergência, o PDF prevalece.

### 9.1 Nome e textos
- **Spook** no texto corrido; **SPOOK** (maiúsculas) apenas no logo.
- Mascote: fantasma de neon roxo com headset ("spook" = fantasma em inglês).
- Frases da tela de entrada: "Seus servidores, sua galera, num só lugar." e "Chat · Voz · Vídeo · Compartilhar tela". Não há slogan separado.
- Instalador do desktop: `Spook-<versão>-<so>-<arquitetura>` (ex.: `Spook-0.1.0-windows-x64.exe`).

### 9.2 Cores (tokens do shadcn)

Roxo como cor principal, igual nos dois temas; preto e branco para o resto. Os valores entram como variáveis CSS do shadcn (em `packages/brand`, importadas pelo `apps/web`). Não existe tom do Tailwind igual a `#7C5CC4`, então a cor entra como personalizada.

| Variável shadcn | Uso | Claro | Escuro |
| --- | --- | --- | --- |
| `--primary` | Cor da marca: botões, links, destaques | `#7C5CC4` | `#7C5CC4` |
| `--primary-foreground` | Texto sobre a cor principal | `#FAFAFA` | `#FAFAFA` |
| `--background` | Fundo da tela | `#FFFFFF` | `#060606` |
| `--card`, `--popover` | Painéis e cartões | `#FFFFFF` | `#0D0D0D` |
| `--sidebar` | Barra lateral | `#F7F7F7` | `#0B0B0B` |
| `--foreground` (e `*-foreground` neutros) | Texto principal | `#0A0A0A` | `#FAFAFA` |
| `--muted-foreground` | Texto secundário | `#636363` | `#9E9E9E` |
| `--secondary`, `--muted` | Cinza de apoio: botões secundários, áreas suaves | `#F2F2F2` | `#1B1B1B` |
| `--accent` | Destaque suave no hover (tom arroxeado) | `#F1ECFA` | `#221B33` |
| `--border`, `--input` | Bordas | `#E1E1E1` | `#222222` |
| `--ring` | Anel de foco (teclado) | `#A58BE6` | `#A58BE6` |
| `--destructive` | Erro e ações destrutivas (fundo de botão) | `#9F0712` | `#9F0712` |
| `--destructive-text` (personalizada) | Texto de erro | `#9F0712` | `#FF6467` |

- O erro continua vermelho de propósito: um botão de excluir roxo pareceria um botão comum.
- Tema inicial: o do sistema operacional; o usuário pode trocar e a escolha fica salva.

**Paleta do logo** (mascote, lettering e ilustrações): `#16112A` corpo · `#3B2A6B` sombra · `#5E44A8` base · `#7C5CC4` principal · `#A58BE6` claro · `#CDBEF5` suave · `#EEE8FF` núcleo.

### 9.3 Tipografia
- **Interface:** Instrument Sans, pesos 400, 500 e 600. Auto-hospedada via `@fontsource/instrument-sans` (funciona offline no Tauri).
- **Logo:** Baloo 2 peso 800, só no lettering. Nos arquivos ela já está convertida em contorno; não é carregada no app.
- As duas fontes usam a licença SIL Open Font License.

### 9.4 Arquivos e onde usar

Todos os arquivos ficam em `packages/brand/assets/`. Os destinos abaixo são cópias ou referências geradas no build.

| Uso | Arquivo | Destino |
| --- | --- | --- |
| Mascote nas telas e notificações | `logo.svg` / `logo.png` (fundo escuro), `logo-fundo-claro.svg` / `.png` | Componente `<Logo>` que troca a versão conforme o tema |
| Lettering (login, cabeçalhos) | `lettering-fundo-escuro.svg` / `.png`, `lettering-fundo-claro.svg` / `.png` | Componente `<Lettering>` com troca por tema |
| Versão horizontal | `logo-horizontal-fundo-escuro.svg` / `.png`, `logo-horizontal-fundo-claro.svg` / `.png` | Tela de login e página de convite |
| Mini logo (avatar padrão, perfil) | `mini-logo.svg` / `.png` | Placeholder de ícone de servidor e avatar |
| Aba do navegador | `favicon.ico`, `favicon.png` | `apps/web/public/` |
| iPhone e iPad | `apple-touch-icon.png` (180 px, fundo `#0A0A0A`) | `apps/web/public/` |
| PWA / app instalável | `icon-192.png`, `icon-512.png`, `icon-maskable.png` | `apps/web/public/` + `manifest.webmanifest` |
| Prévia de link | `og-image.png` (1200 × 630) | `apps/web/public/` + meta tags Open Graph |
| Desktop (Windows, macOS, Linux) | `icon.png` (1024 × 1024) | Gerar com `pnpm tauri icon` em `apps/desktop/src-tauri/icons/` |
| E-mails (futuro) | `mail/logo.png`, `mail/lettering.png` | Reservados; envio de e-mail não está no escopo atual |

- O neon dos SVGs usa filtro de brilho (`feGaussianBlur`). Onde o filtro pesar ou não renderizar (listas longas, ícones pequenos), usar o PNG ou a mini logo.
- Cores de e-mail (fundo `#050505`, cartão `#111111`, botão `#7C5CC4`, confirmação `#16A34A`) ficam registradas para quando houver envio de e-mail.

---

## 10. Questões em aberto

1. **Metas de performance da seção 4:** confirmar ou ajustar após o baseline do Laravel.
2. **Limites de negócio** (100 servidores por usuário, 25 MB por anexo, 10 pessoas por DM em grupo): valores iniciais, a validar.
3. **Backup do Postgres e do Garage** no VPS: estratégia e frequência.
4. **Canal de coleta de feedback** dos usuários após a fase 7.
5. **Disponibilidade do nome Spook:** registro de marca no INPI e nas lojas de aplicativos (pendência da ficha de identidade).
6. **Revisão do vetor final por um designer:** alguns programas de design não importam o filtro de neon do SVG.
