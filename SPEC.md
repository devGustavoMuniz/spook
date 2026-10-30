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

Cada fase só é concluída quando todos os critérios forem atendidos **e** o benchmark da fase estiver versionado em `bench/` com resultados registrados.

A partir da Fase 1, as medições de cada fase são feitas contra produção no VPS.

### Fase 0 — Fundação
- [ ] `pnpm dev` sobe web, backend, Postgres, Garage e LiveKit localmente com um comando.
- [ ] CI roda lint (golangci-lint e Biome), testes e build com sucesso.
- [ ] Traces de uma requisição aparecem no Grafana.
- [ ] O baseline k6 do Laravel está registrado.

### Fase 1 — Auth, usuários e deploy no VPS
Entrega o deploy em produção, no padrão do VPS (RNF05): Docker Compose de produção em `deploy/`, rodando como o usuário `spook` com Docker rootless; entrada por container `cloudflared` com túnel próprio para `spook.dottadigital.com`, `spook-rtc.dottadigital.com` e `spook-files.dottadigital.com`; mídia do LiveKit direto no IP público; imagens buildadas no CI e publicadas no GHCR (sem build no VPS); segredos fora do git; e deploy reproduzível por GitHub Actions via SSH (push na `main` e `workflow_dispatch`). A preparação única do servidor fica documentada em `deploy/README.md`.

- [ ] Usuário se cadastra, faz login, edita o perfil e faz logout.
- [ ] Rotas protegidas retornam 401 sem autenticação.
- [ ] Client TypeScript gerado a partir do OpenAPI e usado pelo front.
- [ ] Deploy reproduzível no VPS (GitHub Actions por SSH, Docker rootless, imagens do GHCR), com os três domínios acessíveis pelo túnel e segredos fora do repositório.
- [ ] `https://spook.dottadigital.com/healthz` responde ok em produção.
- [ ] O cenário k6 do baseline (Fase 0) roda contra o Spook em produção, com o resultado registrado em `bench/results/` ao lado do baseline do Laravel.
- [ ] Medido: p95 de login e RAM ociosa do backend.

### Fase 2 — Servidores, canais e mensagens (REST)
- [ ] Todos os RF02 a RF06 funcionam via REST, com as regras da seção 7 aplicadas e testadas.
- [ ] Paginação por cursor retorna páginas consistentes com 1M de mensagens no banco.
- [ ] Medido: p95 de listar e enviar mensagens.

### Fase 3 — Gateway realtime
**Pendência bloqueante (primeiro critério abaixo):** observabilidade em produção via Grafana Cloud (plano gratuito), com apenas um coletor OpenTelemetry leve no VPS enviando traces, métricas e logs. Prometheus, Loki e Grafana não rodam no VPS, para não pesar no servidor nem distorcer os benchmarks (o dev local continua com Tempo e Grafana via Compose). Até lá, o backend em produção roda com OTLP desligado.

- [ ] Traces e métricas do backend em produção chegam ao Grafana Cloud via coletor OpenTelemetry no VPS.
- [ ] Mensagem enviada aparece nos outros clientes sem recarregar a página.
- [ ] Derrubar a conexão e reconectar recupera os eventos perdidos (resume).
- [ ] Usuário sem VIEW_CHANNEL não recebe eventos daquele canal.
- [ ] Medido: latência ponta a ponta p50/p95/p99 e conexões por GB de RAM, Spook vs Laravel Reverb.

### Fase 4 — Presença e DMs
- [ ] Status muda em tempo real para os demais usuários.
- [ ] "Digitando…" aparece e expira corretamente.
- [ ] DMs 1:1 e em grupo funcionam com as regras da seção 7.4.
- [ ] Medido: CPU e mensagens/s com N usuários conectados.

### Fase 5 — Voz, vídeo e tela (web)
- [ ] Dois usuários conversam por voz num canal; um compartilha a tela e o outro vê.
- [ ] A lista de participantes do canal de voz atualiza em tempo real para todo o servidor.
- [ ] Permissões CONNECT, SPEAK e VIDEO são respeitadas.
- [ ] Medido: CPU e banda do VPS por participante; jitter, perda e RTT.

### Fase 6 — Uploads e notificações
- [ ] Upload de imagem gera thumbnail e aparece na mensagem.
- [ ] Arquivos acima do limite ou de tipo inválido são rejeitados.
- [ ] Contagem de não lidas é correta após ler e ao receber novas mensagens.
- [ ] Web push chega quando o usuário está offline.
- [ ] Medido: throughput de upload e tempo do job de thumbnail.

### Fase 7 — Desktop
- [ ] O app Tauri roda no Windows, macOS e Linux com todas as funcionalidades da web.
- [ ] Voz e compartilhamento de tela funcionam no Linux e no macOS via captura nativa.
- [ ] Medido: RAM ociosa, RAM em call, tamanho do instalador e tempo de boot, Tauri vs Electron.
- [ ] Versão liberada para usuários e canal de feedback definido.

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
