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
- Adicionais de qualidade de vida (entraram depois das fases 0 a 7; requisitos RF13 a RF21): responder com citação, fixar mensagens e editar com ↑; Não perturbar, Invisível e status personalizado; silenciar e nível de notificação; volume por pessoa, ruído em 3 níveis, porta de ruído e teste de microfone; qualidade da tela e Picture-in-Picture; bandeja, início com o sistema, contador no ícone e clique na notificação no desktop; painel administrativo `/admin`

### 2.2 Fica de fora (por enquanto)

- **Fase 8:** app mobile (Expo). Começa só após uso real e feedback da fase 7.
- **Fase 9:** overengineering (NATS com múltiplas instâncias do gateway, busca com Meilisearch, cache, testes de caos).
- Bots e API pública
- Do bloco de adicionais, continuam fora: respostas em thread, evento/aviso de "mensagem fixada" no canal, mais de 50 fixadas, horário agendado de Não perturbar, push para nível "tudo" em servidor, silêncio por categoria, nível padrão global por usuário, emoji picker completo, Picture-in-Picture no desktop, push-to-talk, Ctrl+K e rascunho por canal (descartados pelo dono), DeepFilterNet3, SSE no `/admin`, banimentos, amizades e bloqueios (não existem no Spook)
- Criptografia ponta a ponta
- Gravação de chamadas
- Moderação avançada (automod, logs de auditoria); o painel `/admin` (RF21) é só de leitura e não modera
- Reações, threads, menções com autocomplete, embeds de links (responder com citação e fixar mensagens **entraram**, ver RF13 e RF14)
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

### Adicionais (qualidade de vida, fora das fases 0 a 7)

Entraram depois do checkpoint do SPEC (`checkpoint-spec-completo`). As decisões de implementação estão nos blocos "Adicional: ..." da seção 5.5; as regras e os limites, em 7.9; o aceite, na seção 8 ("Adicionais"). "Teste" indica o que verifica automaticamente; o que só o dono valida está em `VALIDACAO-MANUAL.md`.

### RF13 — Responder e editar a última (adicional)
- RF13.1 Responder a uma mensagem do mesmo canal ou DM: `POST /channels/{id}/messages` aceita `reply_to` (ID) e `mention_reply` (padrão `true`). A mensagem traz `reply_to` (`{id, author, content, has_attachments, deleted}`) com o texto truncado em 100 runes; se a original foi apagada depois, `deleted=true` e `content` vazio.
- RF13.2 Com `mention_reply` e outro autor que vê o canal, o autor respondido entra em `mention_ids` (contador de menção, destaque e push como um `@`); quem responde a si mesmo não se menciona.
- RF13.3 Original inexistente, apagada ou de outro canal: 422 e nada é gravado.
- RF13.4 Na interface, clicar na citação rola até a original (carrega até 10 páginas anteriores; fora disso avisa "fora do histórico carregado"). Atalho **R** na mensagem focada; Esc cancela a resposta.
- RF13.5 Com o campo vazio, ↑ abre a edição da última mensagem não apagada do próprio usuário entre as carregadas (ignorado durante composição IME e com modificadores).
- Aceite: responder cria citação nos dois clientes, com e sem `mention_reply`; original apagada vira "Mensagem original apagada"; `reply_to` de outro canal dá 422; o histórico não faz N+1 para as citações; ↑ edita a própria última mensagem e não faz nada sem mensagem própria carregada.
- Teste: `server/internal/app/replies_pins_integration_test.go`, unitários de `internal/message`, `apps/web/src/replies-pins.test.tsx`, `reply-pins-cache.test.ts` e `e2e/replies-pins.spec.ts`.

### RF14 — Fixar mensagens (adicional)
- RF14.1 Fixar e desafixar: `PUT|DELETE /channels/{id}/pins/{message_id}` (204, idempotentes). `GET /channels/{id}/pins` lista as fixadas, a mais recente primeiro (até 50).
- RF14.2 Máximo de 50 fixadas por canal; a 51ª dá 409.
- RF14.3 Fixar/desafixar publica `MESSAGE_UPDATE` com `pinned` novo (não há evento de lista); apagar uma fixada a desafixa.
- RF14.4 Interface: botão "Mensagens fixadas" no cabeçalho do canal/DM (painel com "Ir para a mensagem" e "Desafixar"), alfinete na mensagem, atalho **P**.
- Aceite: quem tem `MANAGE_MESSAGES` (ou qualquer participante de DM) fixa; os outros veem o painel mas não o botão de fixar; o 51º dá 409 e apagar uma fixada libera vaga.
- Teste: `replies_pins_integration_test.go` (limite de 50, cargo com MANAGE_MESSAGES, DM, WebSocket) e os testes web acima.

### RF15 — Status e presença avançada (adicional)
- RF15.1 A pessoa escolhe a preferência: Online, Não perturbar (`dnd`) ou Invisível; "Ausente" continua automático (10 min sem interação). Os outros veem `online | idle | dnd | offline`.
- RF15.2 Invisível aparece offline (sem status personalizado) para terceiros; a conexão, a voz e o recebimento de mensagens não mudam, e a própria pessoa se vê invisível. Vale em todas as abas (`PRESENCE_SELF_UPDATE`).
- RF15.3 Status personalizado: texto (até 128), emoji (até 32; ao menos um dos dois) e expiração opcional de até 48 h (opções do cliente: não limpar, 30 min, 1 h, 4 h, hoje). Vencido, deixa de existir sem job.
- RF15.4 `GET|PATCH /api/users/@me/presence`; a preferência e o status persistem e voltam no `READY`.
- Aceite: `dnd` vale mesmo ausente; invisível não "pisca" online ao conectar; status vencido não aparece nem no banco velho; expiração acima de 48 h ou no passado dá 422.
- Teste: unitários de `internal/presence`, `status_mute_integration_test.go`, testes web do seletor e `e2e/status-mute.spec.ts`.

### RF16 — Silenciar e nível de notificação (adicional)
- RF16.1 Silenciar servidor, canal ou DM por 15 min, 1 h, 8 h, 24 h ou até reativar; reativar a qualquer momento.
- RF16.2 Nível `all` (tudo), `mentions` (só menções) ou `none` (nada), com herança canal/DM -> servidor -> padrão (servidor: só menções; DM: tudo).
- RF16.3 Silêncio e nível suprimem push, toast e notificação nativa; a contagem de não lidas e de menções continua. Não perturbar suprime os mesmos avisos.
- RF16.4 `GET|PUT|DELETE /api/users/@me/notification-settings[/{scope}/{target_id}]`; `NOTIFICATION_SETTINGS_UPDATE` sincroniza as sessões.
- Aceite: silêncio vencido deixa de valer sem job; em DM com "só menções", mensagem sem `@` não avisa; o contador cresce mesmo silenciado.
- Teste: unitários de `internal/notification`, `notifications_integration_test.go`/`status_mute_integration_test.go` (push com DND, silêncio, nível e vencido), testes web do menu e da página, `e2e/status-mute.spec.ts`.

### RF17 — Áudio e microfone (adicional)
- RF17.1 Volume por pessoa e do áudio da tela dela, separados, de 0 a 100% na web e até 200% no desktop; "silenciar só para mim"; persiste enquanto a pessoa está na sala e é reaplicado ao republicar. Só afeta quem ouve.
- RF17.2 Supressão de ruído em três níveis (Desligada, Padrão do navegador/AEC+NS, Forte com RNNoise), cancelamento de eco e ganho automático, com interruptores; trocar durante a chamada não derruba a sala. O Forte rebaixa sozinho para Padrão, com aviso, se não houver suporte, o download falhar ou a CPU não acompanhar.
- RF17.3 Porta de ruído (sensibilidade de entrada) automática ou manual, com medidor de nível.
- RF17.4 Teste de microfone: grava ~5 s do microfone processado e toca no alto-falante escolhido; desabilitado com o microfone aberto na chamada.
- Aceite: volume 0 silencia só localmente; níveis de ruído trocam sem recriar a sala; o teste nunca toca a voz ao vivo.
- Teste: `features/voice/*.test.ts(x)` (porta real em `vm`, mixer, MicTester, engine web, diálogos) e, no desktop, módulos Rust `gate`, `mixer`, `mictest` (SPEC 5.5).

### RF18 — Compartilhamento de tela: qualidade e janela flutuante (adicional)
- RF18.1 Presets de qualidade (Nitidez, Equilibrado, Fluidez, Alta) e avançado (altura 720/1080/1440, fps 15/30/60, prioridade nitidez/fluidez), com estimativa de banda e aviso de custo; o padrão é o comportamento anterior (1080p, 15 fps, 2,5 Mbps).
- RF18.2 Picture-in-Picture nos vídeos de outra pessoa, só na web e onde o navegador suporta; fecha quando a faixa ou a chamada termina. No desktop o botão não aparece.
- Teste: `screen-quality.test.ts`, `screen-share-dialog.test.tsx`, PiP simulado em `video-grid.test.tsx`; Rust `quality`.

### RF19 — Controles de voz no painel do usuário (adicional)
- RF19.1 No canto inferior esquerdo, o cartão "Voz conectada" (canal, servidor, sair, câmera, tela) fica acima da linha do usuário, e mic/fone/Dispositivos ficam ao lado do nome.
- RF19.2 Fora da chamada, mutar/ensurdecer só guarda a preferência e vale ao entrar.
- Teste: `apps/web/src/voice.test.tsx` e `e2e/voice.spec.ts` exercitam a barra; aparência na validação manual.

### RF20 — Casca do app desktop (adicional)
- RF20.1 Ícone na bandeja (Abrir/Sair; clique alterna) e "Fechar vai para a bandeja" (padrão ligado, com aviso único).
- RF20.2 Iniciar com o sistema (padrão desligado) e iniciar minimizado (só vale nas aberturas automáticas).
- RF20.3 Contador de menções + DMs não lidas no ícone (Dock no macOS, sobreposição no Windows, título no Linux).
- RF20.4 Clicar na notificação nativa abre o canal (heurística de 10 s sobre o foco da janela).
- RF20.5 Página `/settings/app`, só no desktop, com os três interruptores persistidos e erro com reversão.
- Teste: Rust `settings`, `badge`; web `shell.test.ts`, `app-settings.test.tsx`; bandeja, autostart e badge reais só na validação manual.

### RF21 — Painel administrativo (adicional)
- RF21.1 Administrador = `users.is_admin`; promovido por `ADMIN_USERNAMES` no boot (nunca rebaixa) ou por `spook admin grant|revoke|list` (via `deploy/admin.sh` por SSH).
- RF21.2 `/admin` (Dashboard, Usuários, Servidores, Chamadas) mostra contagens, séries de 14 dias, comparação de 6 dias, chamadas ao vivo e uso do LiveKit, aplicação, banco, jobs e gateway. Somente leitura.
- RF21.3 Atualização em tempo real por polling (5 s ao vivo/sistema, 30 s visão geral), com cache no servidor.
- RF21.4 Qualquer não admin: 401 sem sessão e 403 com sessão; a lista de usuários nunca devolve senha, token ou chave de avatar.
- Teste: `server/internal/admin/service_test.go`, `server/internal/app/admin_integration_test.go`, Vitest + MSW e `apps/web/e2e/admin.spec.ts`.

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

**Fase 4 (front)**
- **Rotas.** `/channels/@me` (lista de conversas + estado vazio) e `/channels/@me/$channelId`. A rota estática vence `/channels/$guildId`, então `@me` nunca é tratado como servidor. O botão **Início** do topo da barra de servidores agora leva a `/channels/@me` (antes ia a `/`); `/` continua abrindo o último servidor. A DM abre no mesmo componente de mensagens dos canais (`ChannelView` recebe `guild` ou `dm`): em DM não há permissões de servidor, então só o autor edita e exclui e o composer sempre aparece (o servidor responde 404 a quem não participa).
- **Cache de DMs.** `GET /users/@me/channels` é a fonte (`queryKeys.dms`), semeada pelo `private_channels` do READY e mantida por `lib/dm-cache.ts` (`setDMs`/`upsertDM`/`removeDM`/`bumpDM`), sempre reordenada por atividade (`last_message_id`, ou o id do canal sem mensagens; comparação numérica de Snowflake). `CHANNEL_CREATE/UPDATE` com `guild_id: null` vão para esse cache, nunca para o de servidores. `MESSAGE_CREATE` em DM sobe a conversa. `CHANNEL_DELETE` de DM (saí ou fui removido) tira a conversa, apaga o histórico do cache e, se ela estava aberta, mostra o aviso "Você não está mais na conversa …" e leva à lista; o eco de quem saiu pelo app (que já tirou a DM do cache e navegou) é silencioso. Títulos: 1:1 = nome do outro; grupo = o nome ou os nomes dos demais participantes.
- **Não lidas (só na sessão).** `features/dms/unread-store.ts` marca a DM que recebeu mensagem de outra pessoa enquanto não estava aberta: bolinha no botão Início e no item da lista, que também fica em negrito. Limpa ao abrir e zera ao sair; nada é persistido (a contagem real é a Fase 6, `read_states`).
- **Iniciar conversas.** Menu "Enviar mensagem" no menu de cada membro da lista de membros (todos menos eu; "Expulsar" e "Gerenciar cargos" seguem condicionados às permissões). "Nova conversa em grupo" (botão `+` da lista e do estado vazio): as pessoas vêm dos membros de **todos** os meus servidores (reaproveita o cache de membros, 1.000 por servidor, sem repetidos e sem mim); de 1 a 9; o nome é opcional e, como a criação não aceita nome, vai num `PATCH` logo depois (se falhar, a conversa existe e o aviso diz isso). Gestão do grupo (diálogo "Participantes" no cabeçalho): o dono renomeia, adiciona (limite de 10 contando os atuais) e remove; participante só sai (com confirmação); o dono não vê "sair" nem "remover" (o servidor também recusa com 409). Depois de cada ação o cache é atualizado com a resposta; o `CHANNEL_UPDATE` que chega em seguida é idempotente.
- **Erros de DM (pt-br, `dmMessage`).** O mesmo status vira texto conforme a ação: 403 ao abrir/criar/adicionar = "só com quem compartilha um servidor", nas demais = "só o dono"; 404 = "não participa mais"; 409 ao adicionar = grupo cheio (10), nas demais = dono não sai nem é removido; 422 = escolha de 1 a 9 pessoas (ou nome de 1 a 100 caracteres ao renomear); 429 usa o `Retry-After` ("Tente de novo em N s").
- **Presença.** Store Zustand (`features/presence/store.ts`) com `user_id → online|idle`; quem não está no mapa é offline. O READY **substitui** o snapshot; `PRESENCE_UPDATE` altera um usuário (offline remove). O snapshot não traz o próprio usuário, então o app se registra como `online` no READY e acompanha o que o detector sinaliza (assim a própria bolinha também aparece certa). Indicador `PresenceDot`/`StatusAvatar` (verde online, âmbar ausente, cinza offline; `role="img"` com texto "Online/Ausente/Offline") na lista de membros, na lista de DMs (1:1), no cabeçalho da DM e no diálogo de participantes. Sem polling; o estado vive só na memória e é zerado ao sair.
- **Inatividade (10 min).** `features/presence/idle-detector.ts`: ouve `mousemove`, `mousedown`, `keydown`, `touchstart`, `wheel`, `focus` e a aba voltando a ficar visível; guarda só o instante da última interação e reagenda **um único** timer (não reinicia timer a cada movimento do mouse). Ao completar 10 min parado chama `setPresence("idle")`; qualquer interação depois disso chama `setPresence("online")`. Aba oculta **não** vira ausente por si só (conta o tempo sem interação, como o servidor espera). `GatewayClient.setPresence` guarda o estado desejado e manda o op 12 só quando muda e com a conexão pronta; ao reconectar reenvia: depois de **READY** só se for `idle` (sessão nova já começa online) e depois de **RESUMED** sempre (a sessão guardada pode estar diferente do que o app quer agora).
- **READY ampliado.** `private_channels` e `presences` no schema Zod do READY com `default([])` (tolera servidor anterior à Fase 4; o servidor atual sempre manda arrays); `channelPayloadSchema` ganhou `owner_id` e `recipients`; op 12 (`Op.PresenceUpdate`, `setPresenceFrameSchema`) e o contract test cobre `ready`, `set_presence` e `dm_channel_create` do fixture. `packages/shared/src/index.ts` passou a exportar os endpoints `dms` do orval (estavam gerados e não exportados).
- **"Digitando…".** O composer avisa com `POST /channels/{id}/typing` na primeira tecla de texto não vazio e depois no máximo a cada 3 s por canal (`features/typing/throttle.ts`; o servidor também limita); apagar tudo não avisa, enviar zera o intervalo, falha do aviso é ignorada. O store (`features/typing/store.ts`) guarda `canal → usuários` com um timer de 8 s por pessoa, renovado a cada `TYPING_START`; `MESSAGE_CREATE` do mesmo autor encerra na hora; o evento do próprio usuário é ignorado; READY e lacuna de eventos zeram tudo (o fim pode ter se perdido). Texto: "X está digitando…", "X e Y estão digitando…", "Várias pessoas estão digitando…" (3 ou mais); o nome vem dos membros do servidor ou dos participantes da DM ("Alguém" se não resolver). A linha do indicador reserva a altura para a lista não pular.
- **Backend (lacuna corrigida).** A tolerância de offline só era configurável por `Deps.Presence` (código). Nova variável `SPOOK_PRESENCE_OFFLINE_GRACE` (duração do Go, ex.: `2s`; vazia = padrão de 15 s; valor inválido derruba a inicialização) lida em `platform/config` e ligada em `cmd/spook/main.go`; só o E2E a usa (`ci.yml` e `apps/web/README.md`).
- **Testes.** Unitários: store de presença, detector de inatividade (relógio falso, eventos do navegador), store de "digitando…" (expiração e renovação com relógio falso, textos, throttle), `dm-cache`, `setPresence` no cliente (online/idle, READY vs RESUMED) e o contract test com os fixtures novos; `cache-bindings` para DMs/presença/typing; componentes e gateway com o app inteiro e WebSocket falso (`src/dms.test.tsx`: lista, estado vazio, abrir DM pelo menu do membro, diálogo de grupo, gestão, erros 403/422/429, presença na lista/cabeçalho/membros, mensagem em tempo real, não lidas, `CHANNEL_DELETE`, "digitando…" com expiração). E2E (`e2e/dms.spec.ts`, backend real com `SPOOK_PRESENCE_OFFLINE_GRACE=2s`, três contas criadas uma vez e `storageState` reaproveitado): A abre DM com B pelo menu do membro, trocam mensagens em tempo real, B vê A online e, ao A fechar a aba, offline; "digitando…" aparece, expira e some ao enviar; ausente após 10 min com `page.clock` e volta a online ao interagir; grupo com 3 contas (criar, adicionar, remover → removido deixa de receber e a API devolve 404 a ele; participante sai). Não coberto por teste automatizado: a conversa real de 10 minutos no relógio de parede e o visual claro/escuro (ver `VALIDACAO-MANUAL.md`).


**Fase 5 — Voz, vídeo e tela (backend)**
- **Arquitetura (`internal/voice`, hexagonal).** Domínio (`voice.go`: `State`, origens de mídia, `Grants`), portas (`ports.go`: `Provider` = LiveKit, `StateStore`, `Access` = canais e permissões, `Users`), aplicação (`service.go`: casos de uso) e adaptadores: `voice/livekit` (`livekit/protocol`: JWT `auth`, `webhook.ReceiveWebhookEvent` e o cliente twirp `RoomService` com token de administração; sem o server-sdk-go), `voice/memory` (estado) e, no pacote `app`, `voiceAccess`/`voiceUsers`, que ligam `channel.Authorize` (que já cobre servidor e DM), `guild.Member` e `perm` sem que `voice` importe store de outra feature. Sala = ID do canal; identidade = ID do usuário; nome = username. Sem `LIVEKIT_URL`, `LIVEKIT_API_KEY` e `LIVEKIT_API_SECRET` a voz fica desligada: os endpoints respondem **503** em pt-br, o webhook também, e o READY traz `voice_states: []`. Novo `apperr.KindUnavailable` (503).
- **Endpoints.** `POST /api/channels/{id}/voice/token` → `{url, token, expires_in: 600}`; `POST /api/voice/leave` (204, idempotente); `PATCH /api/voice/state` `{self_mute, self_deaf}` (200 com o estado; 409 se não está em voz); `GET /api/guilds/{id}/voice-states` (snapshot; 404 não-membro, 403 sem VIEW_CHANNEL). Fora do OpenAPI: `POST /api/livekit/webhook`.
- **Token (RNF04).** JWT de uma sala só (`room`), `roomJoin`, `canSubscribe` sempre, expiração de **10 min**. Origens publicáveis: SPEAK → `microphone`; VIDEO → `camera`, `screen_share`, `screen_share_audio`; sem nenhuma, `canPublish=false` (o LiveKit trata lista vazia como "tudo", por isso o `false` explícito). DM 1:1 e em grupo: participante, quatro origens. Canal de servidor: 404 não-membro/inexistente, 403 sem VIEW_CHANNEL **ou** sem CONNECT, 422 texto/categoria; DM: 404 para quem não participa.
- **Um canal por vez (7.7) e a corrida com o webhook.** Pedir token para outro canal remove o participante da sala antiga no LiveKit (`RemoveParticipant`), apaga o estado e publica a saída; mute/deafen acompanham a troca. A emissão grava uma **intenção pendente** (usuário → canal, TTL curto de 30 s) em memória. O webhook `participant_joined` usa a intenção: entrada numa sala diferente da pendente é conexão com **token velho** (cada token vale 10 min) e é derrubada; entrada sem pendente (TTL vencido, token ainda válido) é aceita, mas se o usuário já está em **outro** canal ela também é derrubada (a decisão de trocar de canal é sempre o pedido de token). `PATCH /voice/state` entre o token e o webhook vale: o mute/deaf fica na intenção e entra no estado na chegada. Toda transição de um usuário é serializada por uma trava por usuário (64 faixas).
- **Webhook.** Autenticidade só pela assinatura (header `Authorization` = JWT assinado com o segredo da API e o SHA-256 do corpo, verificado por `livekit/protocol`); inválida ou ausente → 401; corpo máximo de 1 MiB (413); **fora do rate limit por IP** (o tráfego é do container do LiveKit na rede do Compose, um IP só). Idempotente: deduplica pelo `id` do evento (últimos 2.048) e cada transição é idempotente por si (entrada repetida não publica; `participant_left` com SID diferente do atual é ignorado, porque o LiveKit pode entregar a saída da conexão antiga depois da entrada da nova; saída de sala que não é a atual é ignorada). Eventos usados: `participant_joined`, `participant_left`, `track_published`/`track_unpublished` (câmera = origem `camera`, tela = `screen_share`) e `room_finished`; salas e identidades que não são IDs numéricos (egress/ingress) são ignoradas. Erro de infraestrutura devolve 500 e o LiveKit repete.
- **Eventos.** `VOICE_STATE_UPDATE {guild_id|null, channel_id|null, user_id, self_mute, self_deaf, self_video, self_screen}` (os nomes `self_video`/`self_screen` do contrato da Fase 3 foram mantidos; `channel_id` nulo = saiu, com vídeo e tela falsos). Servidor: tópico `guild:<id>` com `GuildID` e `ChannelID` preenchidos, e o gateway só entrega a quem tem VIEW_CHANNEL (`VOICE_STATE_UPDATE` entrou no filtro `allows`). DM: tópico `channel:<id>`, só os participantes inscritos. O READY ganhou `voice_states` (sempre array): estados dos servidores em que o usuário tem VIEW_CHANNEL e das DMs dele, calculado em memória a partir do que o gateway já tinha carregado (zero consulta extra). O payload passou a ser o tipo `voice.StatePayload` (`gateway.VoiceStateUpdate` é um alias, o JSON não mudou) e o fixture ganhou `ready.d.voice_states`.
- **Reavaliação de permissões.** `voice.Service.OnEvent` assina o barramento: `ROLE_UPDATE`, `ROLE_DELETE`, `GUILD_MEMBER_UPDATE`, `GUILD_MEMBER_REMOVE`, `GUILD_UPDATE`, `GUILD_DELETE`, `CHANNEL_UPDATE` e `CHANNEL_DELETE` reavaliam todos os participantes do servidor (ou, em DM, da sala) com a mesma autorização do token: perdeu CONNECT/VIEW_CHANNEL, saiu do servidor/DM ou o canal sumiu → removido da sala e saída publicada; mudou SPEAK/VIDEO → `UpdateParticipant` no LiveKit (o estado guarda as últimas permissões aplicadas, então evento sem mudança não chama o LiveKit); sem VIDEO, câmera e tela saem do estado. Erro de infraestrutura na reavaliação **nunca** derruba ninguém (tenta no próximo evento).
- **Reconciliador (a cada 60 s).** Consulta `ListRooms`/`ListParticipants`: remove estados órfãos (LiveKit reiniciou, webhook perdido) e registra participantes que o backend não conhecia (o backend reiniciou: o estado só em memória se reconstrói assim) e corrige os flags de câmera/tela pelas tracks. Proteções: erro ao consultar uma sala nunca remove os estados dela, e só é órfão quem entrou **antes** do início da consulta (o webhook pode ter chegado antes da lista).
- **Configuração do LiveKit no deploy.** O LiveKit chama o backend em `http://spook:8090/api/livekit/webhook` (rede interna do Compose) com `webhook.api_key` igual a `LIVEKIT_API_KEY`. Esse valor vem do `.env` do servidor e não está no git, então `deploy/livekit/livekit.prod.yaml.tmpl` (versionado, com `__LIVEKIT_API_KEY__`) é **renderizado pelo `deploy.sh`** (`sed`, chave validada contra `[A-Za-z0-9_-]`) para `deploy/livekit/livekit.prod.yaml` (não versionado, é o arquivo montado). O `CONFIG_HASH` é calculado **depois** da renderização, então trocar a chave também recria o container. Em dev, `livekit.yaml` aponta o webhook para `http://server:8090/...` (o backend roda no Compose). O serviço `spook` recebeu `LIVEKIT_URL=wss://spook-rtc.dottadigital.com`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` e `LIVEKIT_INTERNAL_URL=http://livekit:7880`; limites de recursos inalterados (soma 1792M).
- **Instrumentação.** Métricas: `spook.voice.participants{channel_type=guild|dm}` (gauge), `spook.voice.tokens.issued{kind}` e `.denied{reason}`, `spook.voice.webhooks{type}`, `spook.voice.token.duration` (histograma, s), `spook.voice.evictions` e `spook.voice.reconcile.orphans`. Spans: `voice.IssueToken`, `voice.Leave`, `voice.SetSelfState`, `voice.Webhook`, `voice.Reevaluate`, `voice.Reconcile`. Cenário `bench/scenarios/voice-token.js` e receita `bench/scripts/livekit-load-test.sh` (seção de voz em `bench/README.md`); a execução é da Fase B.
- **Testes.** Unitários (`Provider` falso): matriz SPEAK/VIDEO/CONNECT → grants, DM, TTL e sala única, um canal por vez (inclusive token velho e saída atrasada), transições por webhook (idempotência, SID, `room_finished`, DM), `PATCH` com intenção pendente, reavaliação por tipo de evento, reconciliador (órfãos, entrada recente, erro, desconhecidos); adaptador `livekit` com JWT decodificado (sala, identidade, origens, `exp`), webhook assinado (válido, segredo errado, corpo adulterado) e twirp contra servidor falso; gateway (READY e filtro de VIEW_CHANNEL). Integração (`app/voice_integration_test.go`): 503, 401/404/403/422, JWT, DM, assinatura do webhook e ausência de rate limit, fluxo completo pelo WebSocket (cego não recebe, snapshots, troca de canal, leave, perda de CONNECT) e reconciliador. Também validado à mão: o LiveKit real (`v1.13.11`) entregou webhooks assinados ao backend real (200) e o adaptador listou, atualizou e removeu participantes reais.
**Fase 5 (front)**
- **`VoiceEngine` é a costura para a Fase 7 (RF12.2).** `apps/web/src/features/voice/engine.ts` define a interface; **só** `web-engine.ts` importa `livekit-client`, e nada fora dele pode presumir `MediaStream`/`MediaStreamTrack`. Contrato: `connect({url, token})`, `disconnect()`, `setMicrophoneEnabled`, `setCameraEnabled`, `setScreenShareEnabled(on, {audio})`, `setDeafened`, `resumeAudio`, `listDevices(kind)`, `setDevice(kind, id)` e `on(evento, handler)` com os eventos `participant-joined/left`, `speakers-changed`, `video-track-added/removed`, `connection-state` (reconexão da lib), `link-quality`, `local-media` (mic/câmera/tela mudaram por fora, p. ex. o botão "parar de compartilhar" do navegador), `audio-blocked`, `devices-changed` e `disconnected {reason: client|removed|network|unknown}`. Falhas de mídia local sobem como `VoiceMediaError` (`permission-denied`, `cancelled`, `not-found`, `in-use`, `unsupported`) e de conexão como `VoiceConnectError` (`token-rejected`, `unreachable`). **Vídeo não é uma faixa:** é um `VideoSource` com `attach(host: HTMLElement) => detach`. A web cria um `<video>` dentro do `host` e faz `track.attach(video)`; o desktop pode criar um `<canvas>` e desenhar os quadros que o Rust enviar, sem tocar na interface. O **áudio remoto é tocado pela própria engine** (a web usa elementos `<audio>` ocultos), então a UI nunca vê faixas de áudio. **Seleção de engine** (`engine-provider.ts`): `setVoiceEngineFactory(f)` injeta a engine (desktop nativo ou dublê de teste); sem injeção, a web usa `createWebVoiceEngine()`; se `window.__TAURI__`/`__TAURI_INTERNALS__` existir e nada tiver sido injetado, falha com mensagem clara em vez de cair no WebRTC do WebView. A Fase 7 só precisa implementar `VoiceEngine` em cima do Rust e chamar `setVoiceEngineFactory` antes de montar a interface.
- **`livekit-client` 2.23.0** (versão exata, publicada em 2026-10-16), contra o servidor `v1.13.11` da produção: a lib 2.x usa o protocolo de sinalização v1.x do servidor; validado de verdade (E2E com mídia real, abaixo). `Room` criada com `adaptiveStream` e `dynacast`.
- **Controlador (`controller.ts`) em vez de hooks.** `joinVoice`, `leaveCall`, `toggleMute/Deafen/Camera/ScreenShare`, `chooseDevice` e a reconciliação com o gateway são funções de módulo (sem React), usadas pela lista de canais, pela barra e pelo botão da DM. Estado em dois stores Zustand: `useVoiceStore` (a minha chamada: canal, status, mudo/surdo locais, quem fala, faixas de vídeo, qualidade, áudio bloqueado) e `useVoiceStatesStore` (`user_id → VoiceState` de todos os canais visíveis; um usuário está em um canal só). Mudo/surdo **sobrevivem** a sair e a trocar de canal (preferência do usuário; o servidor também os mantém na troca).
- **Trocar de canal.** `joinVoice` desconecta a sala antiga **antes** de pedir o token do novo canal; o `disconnected` com motivo `client` é ignorado. Chamadas concorrentes são descartadas por um contador de geração.
- **"Fui removido da sala" vs. troca de canal.** `VOICE_STATE_UPDATE` com `channel_id: null` do próprio usuário só derruba a sala local se o servidor já tinha **confirmado** a entrada (`confirmed`, ligado quando chega o evento do meu usuário no canal atual; zerado a cada `joinVoice`). Sem isso, a saída do canal antigo numa troca (que chega depois do pedido de token) seria confundida com uma remoção. O mesmo vale para o snapshot do READY (que também substitui o mapa inteiro): se eu estava confirmado e não apareço mais no canal local, a sala é encerrada. Entrar em outro canal por outro dispositivo também derruba a sala local, com aviso próprio.
- **Mute/deafen.** Mudo desliga a publicação do microfone; ensurdecer silencia o áudio remoto localmente (`muted` nos elementos de áudio da engine) **e** marca mudo, lembrando o mudo anterior para restaurar ao voltar a ouvir; desmutar ensurdecido também volta a ouvir (como no Discord). Cada mudança chama `PATCH /api/voice/state`; 409 (ainda sem webhook de entrada) é ignorado, e quem entra já mudo (veio mudo do canal anterior, ou o navegador negou o microfone) manda o estado logo depois de conectar. Sem SPEAK, o microfone nem é aberto e o botão fica desabilitado com a explicação; sem VIDEO, câmera e tela ficam desabilitadas; sem CONNECT, o canal fica bloqueado. A UI usa as permissões do servidor (`can(guild, …)`; DM = tudo), mas quem decide é o token.
- **Quedas.** A lib reconecta sozinha (status "Reconectando…"). Se desistir (`disconnected` com `network`/`unknown`), o controlador pede um **token novo** e reentra até 3 vezes (1 s, 3 s, 6 s); durante isso a confirmação é zerada (o webhook de saída da sala velha não pode derrubar a nova). Token recusado ao conectar (vencido, `ConnectionError` 401/403) pede outro uma vez. Desconexão `removed` (perdi CONNECT, saí do servidor/grupo, canal excluído, outra sessão) só limpa e avisa.
- **Fechar a aba.** `pagehide` desconecta a engine e dispara `POST /api/voice/leave` com `fetch(..., {keepalive: true})` (usa o cookie, que o `sendBeacon` também usaria, mas permite o método e o credenciamento explícitos); sair da conta (desmontar a área autenticada) solta a sala sem chamar a API (a sessão já não vale).
- **UI.** Canal de voz da lista vira botão (clique entra ou troca e abre o painel do canal) com os participantes embaixo (avatar com anel verde de quem fala, nome, ícones de mudo/surdo/câmera/tela); painel do canal de voz (`VoiceChannelView`) com entrar/sair, vídeo e lista; barra persistente (`VoiceBar`, montada em `AuthedLayout` abaixo de tudo) com status, qualidade do enlace (3 barras: excelente/boa/ruim/perdida, vinda do LiveKit), mudo, surdo, câmera, tela, dispositivos e sair; grade de vídeo com **destaque** (tela compartilhada por padrão, clique em outro tile para trocar, faixa com os demais, tela cheia por tile); em DMs, botão **Ligar/Entrar na chamada/Sair da chamada** no cabeçalho (sala = ID da DM) e faixa "Chamada em andamento" com quem está nela e o vídeo. O seletor de dispositivos (microfone, alto-falante, câmera) é um diálogo com `<select>` nativos e persiste em `localStorage` (`spook:voice-devices`); é reaplicado ao conectar. Áudio bloqueado pela política de autoplay aparece como botão "Ativar áudio" na barra.
- **Erros em pt-br.** `voiceMessage` (403 sem permissão, 404 canal indisponível, 422 não é canal de voz, 503 voz indisponível) e `mediaMessage` (navegador bloqueou microfone/câmera, seleção de tela cancelada, dispositivo ausente ou em uso).
- **Shared.** Os endpoints de voz do client gerado passaram a ser exportados por `@spook/shared`; `VoiceStatePayload` é o tipo do schema Zod (já existente) e ganhou teste de contrato próprio (saída, DM, campo faltando).
- **E2E.** `e2e/voice.spec.ts` (duas contas, mídia falsa do Chromium e o LiveKit de desenvolvimento: lista, conexão, **áudio remoto chegando, vídeo decodificado, tela compartilhada**, mudo refletido, saída) roda **só com `E2E_VOICE=1`** (projeto Playwright `voice`), nunca no job `e2e` do CI (sem LiveKit lá). O `e2e/voice-off.spec.ts` roda no CI (backend sem LiveKit, 503: aviso em pt-br, sem barra) e pula sozinho se o backend tiver LiveKit. O projeto `voice` usa `channel: "chromium"` (o headless shell padrão ignora `--unsafely-treat-insecure-origin-as-secure`, necessário porque o front é servido por `http://server:8090`, que não é contexto seguro). Receita em `apps/web/README.md`.
- **Testes.** Unitários: stores, permissões, controlador (entrar/trocar/erros/mudo/surdo/quedas/reconciliação) com `FakeVoiceEngine`, engine web com `livekit-client` simulado; componentes e app inteiro com WebSocket falso (`src/voice.test.tsx`).

**Fase 6a — Fila de jobs, uploads e thumbnails (backend)**
- **River.** `riverqueue/river` v0.50 sobre o mesmo Postgres (sem Redis). As migrations do River rodam logo depois do goose, no mesmo `migrate.Up` (sob um advisory lock, para instâncias ou pacotes de teste concorrentes não disputarem as tabelas `river_*`). O client é criado e iniciado em `app.Build` (injeção manual: workers registrados por `attachment.RegisterWorkers`) e parado por `App.Close` no desligamento, depois do HTTP, esperando os jobs em andamento; sem storage ou sem `*pgxpool.Pool` não há client. Filas: `default` (2 workers; limpeza) e `thumbnail` (**2 workers**, cada um decodifica uma imagem por vez). Os logs do River só aparecem a partir de Warn (o debug dele inunda o log de desenvolvimento). Código em `server/internal/platform/jobs` (infra) e `server/internal/attachment` (args e workers).
- **Fluxo de upload sem endpoint de `complete`.** (1) `POST /api/channels/{id}/uploads` cria a linha pendente e devolve a URL de PUT (5 min, `Content-Type` e tamanho assinados) e os `headers` a enviar; (2) o cliente envia o arquivo direto ao storage; (3) `POST /api/channels/{id}/messages` com `attachment_ids` verifica no storage (HEAD para existência e tamanho; range GET dos primeiros 512 bytes + `http.DetectContentType` para imagens, PDF e zip) e só então grava. Não há "completar upload": a verificação acontece na mensagem, que é o único momento em que o anexo importa, e um upload que nunca vira mensagem é apagado pela limpeza. A mensagem, a associação dos anexos (`UPDATE attachments SET message_id … WHERE message_id IS NULL`, que também serve de trava contra duas mensagens disputando o mesmo anexo) e o enfileiramento dos jobs de thumbnail saem na **mesma transação**: ou tudo, ou nada. Divergência de tamanho ou de bytes apaga o objeto e a linha (422); objeto ainda não enviado dá 422 sem apagar (o cliente pode terminar o PUT).
- **Regras.** Máximo de 25 MB (1 B a 26.214.400 B, 422 com mensagem clara acima), 10 anexos por mensagem, nome ≤ 100 caracteres. Pedir upload exige VIEW_CHANNEL + SEND_MESSAGES + **ATTACH_FILES** (DM: participante; não participante = 404); mandar mensagem com anexo exige os mesmos bits. Só canais de texto e DMs. Conteúdo vazio só com anexo. Só vale anexo do próprio usuário, do canal (o canal vem do prefixo da chave `attachments/<channel_id>/…`, já que o SPEC 6 não tem coluna `channel_id`), ainda sem mensagem e com menos de **1 h**; a ordem dos anexos na mensagem é a ordem dos IDs (a de criação). Limites por usuário: 30 pedidos de upload por minuto (429 + `Retry-After`) e 30 anexos pendentes (409). Mensagem apagada (soft delete) some com os anexos da API; os objetos permanecem (não há remoção física ao apagar mensagem; fica como melhoria futura).
- **Lista de permissão de tipos** (RNF04): `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `application/pdf`, `text/plain`, `application/zip`, `audio/mpeg`, `audio/ogg`, `audio/webm`, `video/mp4`, `video/webm`. SVG, HTML, executáveis, JavaScript e `application/octet-stream` são recusados. O tipo precisa casar **exatamente** (minúsculas, sem parâmetros como `; charset=`) e a extensão do nome precisa ser uma das do tipo (`jpg`/`jpeg`, `txt`/`log`/`md`/`csv`, `ogg`/`oga`/`opus`, `weba`/`webm`, `mp4`/`m4v` …). Nome sanitizado: sem caminho (`/`, `\`), sem caracteres de controle nem de formatação Unicode (inclusive os de inversão de direção), `<>:"|?*` viram `_`, sem espaços e pontos nas pontas, corte em 100 caracteres preservando a extensão. A chave do objeto usa uma versão só-ASCII do nome (`[A-Za-z0-9._-]`, o resto vira `_`); a coluna `filename` guarda o nome sanitizado original.
- **Storage.** `platform/storage` ganhou `Stat` (HEAD), `GetRange`, `Get` (com limite de bytes) , `Put` e `Delete` (idempotente), com `ErrNotFound`/`ErrTooLarge`; o domínio usa a interface `attachment.Objects`. Testado contra o Garage do Compose.
- **Payload.** `MessagePayload.attachments` (sempre presente, `[]` sem anexos) no histórico, no envio e em `MESSAGE_CREATE`/`MESSAGE_UPDATE`: `{id, filename, content_type, size, url, thumbnail_url?, width?, height?}`. `url`/`thumbnail_url` são GETs pré-assinados de **1 h** (são assinados a cada resposta; o cliente não deve guardá-los além disso). Os anexos do histórico vêm numa consulta só por página (`WHERE message_id = ANY(...)`), sem N+1; um teste de integração compara a contagem de queries com 2 e 20 mensagens.
- **Thumbnail.** Job `thumbnail` (3 tentativas) por imagem anexada. Baixa o original (limite 25 MB), lê as dimensões com `image.DecodeConfig` **antes** de decodificar e recusa mais de **8192 px** num lado ou **12 MP**; decodifica (jpeg, png, gif — primeiro quadro —, webp), reduz com `x/image/draw.CatmullRom` para caber em **400×400** (mantém a proporção, **nunca amplia**), codifica JPEG q80 (**PNG se houver transparência**), grava `thumbnails/<attachment_id>.<jpg|png>`, atualiza `width`/`height` (da imagem **original**) e `thumbnail_key` e republica `MESSAGE_UPDATE` com o payload completo. Imagem corrompida, grande demais, objeto sumido ou anexo apagado = `river.JobCancel` (sem retentar, sem thumbnail; a mensagem segue com o original); erro de storage/banco retenta. A retentativa é idempotente (se o thumbnail já existe, só republica). Limitação conhecida: a orientação EXIF do JPEG não é aplicada ao thumbnail (o original, no `<img>`, o navegador gira sozinho).
- **Limpeza.** Job periódico `attachment_cleanup` (a cada 10 min e na partida) apaga, em lotes, os anexos sem mensagem há mais de 1 h (linha e objeto).
- **Memória.** Com o thumbnail, o pico do `spook` sobe: 2 workers × (original ≤ 25 MB + imagem decodificada ≤ 12 MP ≈ 36 MB em RGBA ou 18 MB em YCbCr + miniatura). O `mem_limit` passou de 384M para **512M** e o `GOMEMLIMIT` de 300MiB para **400MiB**; a soma de memória dos serviços foi de 1792M para **1920M** (< 2500M), tabela em `deploy/README.md` 1.2 e no cabeçalho do compose.
- **Instrumentação.** Métricas OTel: `spook.uploads.requested{content_type}` e `.bytes`, `spook.uploads.rejected{reason}`, `spook.messages.with_attachments`, `spook.messages.attachments`, `spook.thumbnail.jobs{result=ok|discarded|error}`, `spook.thumbnail.job.duration` (histograma, s), `spook.uploads.orphans.deleted`, `spook.jobs.queue.size{queue}` (gauge; disponíveis + agendados + em retentativa). Spans `attachment.RequestUpload`, `attachment.Verify`, `attachment.ForMessages`, `attachment.thumbnail` (+ `.download`, `.resize`, `.upload`), `attachment.CleanupOrphans`, `message.Send`. O job loga "thumbnail gerado" com `ms`. Cenário k6: `bench/scenarios/upload.js` (como medir o job em `bench/README.md`).

**Fase 6b — Não lidas, menções e Web Push (backend)**
- **Pacote `internal/notification`** (handler/service/store). Assina `MESSAGE_CREATE` no barramento (fila interna de 4.096 eventos e 4 goroutines; o assinante do barramento nunca bloqueia; evento descartado por fila cheia ou erro é contado em `spook.notification.dropped`). `message` não importa `notification`: a resolução de menções no envio chega por uma interface de `message` (`Mentions`) que o `notification.Service` implementa; `notification` só importa de `message` o tipo do payload. O acesso a canal (`Authorize`) e a presença (`Status`) entram por interfaces do próprio pacote. Migration `00006` (aditiva): `read_states`, `push_subscriptions`, `messages.mention_ids bigint[] NOT NULL DEFAULT '{}'` e a função SQL `snowflake_floor(timestamptz)`.
- **Baseline das não lidas.** Não lidas = mensagens de **outros** usuários, não apagadas, com ID > `last_read_message_id`. Sem linha em `read_states` a base é a **entrada no servidor** (`guild_members.joined_at` convertido no menor Snowflake daquele milissegundo, pela função SQL `snowflake_floor`, igual à conta do `internal/platform/snowflake`; um teste de integração confere) ou, em DM, o **ID do canal** (a criação): ninguém herda histórico antigo como não lido. Consequência conhecida: quem é adicionado depois a uma DM em grupo vê o histórico da conversa como não lido (não há data de entrada em `channel_recipients`). `GET` devolve a base em `last_read_message_id` quando não há leitura registrada. Quem sai ou é expulso de um servidor tem os `read_states` dele apagados (`GUILD_MEMBER_REMOVE`), então voltar recomeça da nova entrada.
- **Autor.** Ao enviar, o `MESSAGE_CREATE` avança o `last_read` do autor até a própria mensagem (mesma consulta do ack: **escrever num canal marca tudo que veio antes como lido**, como o Discord faz ao responder). Como esse avanço é assíncrono, a consulta de não lidas também exclui `author_id = usuário`: a própria mensagem nunca conta, nem na janela entre o envio e o avanço. O avanço do autor não emite `READ_STATE_UPDATE` (as outras sessões dele já veem a mensagem no `MESSAGE_CREATE`).
- **Ack monotônico.** `PUT /api/channels/{id}/ack {message_id}` faz upsert com `GREATEST(atual, pedido)`: **nunca regride**. O ID pedido é limitado (`LEAST`) à `channels.last_message_id` na própria instrução (um ID do futuro não "lê" mensagens que ainda não existem). `mention_count` zera quando o `last_read` resultante alcança a última mensagem do canal; em ack parcial o contador é mantido (as menções não são guardadas uma a uma). Exige acesso: não-membro e não-participante 404, sem VIEW_CHANNEL 403, canal de voz/categoria 422 (só texto e DMs têm leitura), `message_id` inválido 422. Resposta 200 com `{channel_id, last_read_message_id, mention_count}`, que também sai como `READ_STATE_UPDATE` no tópico `user:<id>` (todas as sessões do usuário, inclusive a que fez o ack).
- **Consulta e teto de 100.** `GET /api/users/@me/read-states` → `{read_states: [{channel_id, guild_id?, last_read_message_id, mention_count, unread_count}], guilds: [{guild_id, unread_count, mention_count}]}` com um item por canal de texto onde o usuário tem VIEW_CHANNEL (decidido pelas permissões efetivas, como no READY) e por DM. **Uma consulta só**, qualquer que seja o número de canais (teste de integração compara a contagem de idas ao banco com 2 e 38 canais): o canal só paga a contagem quando `last_message_id > last_read`, e ela é um `LIMIT 100` sobre o índice `(channel_id, id DESC)`. **`unread_count` vai até 100 e 100 significa "100 ou mais"** (a UI mostra "99+"); a soma por servidor também é limitada a 100 (`mention_count` por servidor é a soma simples; DMs ficam fora do agregado). O `READY` ganhou `read_states` (sempre array; mesmo formato do item acima, só canais com `unread_count > 0` ou `mention_count > 0`; canal ausente = zero); falha ao calculá-lo não derruba o IDENTIFY (sai `[]`, os eventos seguem valendo).
- **Menções.** Detecta `@username` (sem diferenciar maiúsculas, `[a-z0-9_.]{2,32}`, delimitado; o `@` não pode vir colado a letra, dígito, `_`, `.` ou `@`, então e-mails não valem; ponto no fim do token vale como nome e como pontuação: as duas formas são candidatas) e resolve para usuários que podem **ver o canal** (membros com VIEW_CHANNEL; participantes da DM), em ordem de ID, **no máximo 20 por mensagem** (20 citações lidas), sem o autor. **`@everyone` e `@here` NÃO são suportados** (são só usernames comuns: só notificam se existir uma conta com esse nome). `MessagePayload.mention_ids` (novo, aditivo, **sempre array**) vai no envio, no `MESSAGE_CREATE/UPDATE` e no histórico (guardado em `messages.mention_ids`; editar a mensagem não recalcula nem renotifica). Falha ao resolver menções não impede a mensagem (sai sem destaque). A soma de `mention_count` é um `UPSERT` por mensagem para todos os alvos de uma vez e cada alvo recebe `READ_STATE_UPDATE`. Em **DM, toda mensagem vale como menção** para os outros participantes (badge e push), mencionados ou não.
- **Política do push.** Só em **DM** (todos os outros participantes) ou **menção direta** (só os mencionados); mensagem comum em servidor nunca gera push; o autor nunca recebe. Só para quem **não tem sessão de gateway ativa** (`presence.Status != offline`, então `idle` conta como ativo, e vale a tolerância de 15 s da presença) e tem inscrição. A checagem é refeita na hora do envio (retentativa). Um job River por inscrição na fila própria `push` (**2 workers**, 3 tentativas), com `{subscription_id, message_id, channel_id}`: o texto **não** vai nos argumentos (os jobs concluídos ficam na tabela do River); o worker lê a mensagem na hora e uma mensagem apagada nesse meio tempo não notifica. Payload JSON `{title, body, url, tag}`: título = nome de exibição do autor (fallback username), em servidor `Autor (#canal · Servidor)`; corpo = texto com espaços colapsados, truncado em **120 runes** (`…`), ou `📎 arquivo` se só houver anexo; `url` = `/channels/<servidor>/<canal>` ou `/channels/@me/<canal>`; `tag` = ID do canal. TTL de 1 h, urgência alta, cifra `aes128gcm` e VAPID (lib `webpush-go`). Resposta 404/410 do serviço de push (ou destino bloqueado) apaga a inscrição; 429, 5xx e erro de rede/timeout retentam com o backoff padrão do River (máx. 3); outro 4xx (VAPID ou payload recusados) cancela o job sem retentar.
- **Inscrições.** `GET /api/push/vapid-public-key` → `{public_key}`; `POST /api/push/subscriptions {endpoint, keys:{p256dh, auth}}` (204; upsert pelo `endpoint`, que passa para o usuário que reinscreve; as chaves precisam ter 65 e 16 bytes em base64/base64url); `DELETE /api/push/subscriptions {endpoint}` (204, idempotente, só remove as do próprio usuário). **Máximo de 10 por usuário** (409, serializado por trava no usuário; reinscrever um endpoint existente não conta duas vezes). Rate limit de 30 requisições por minuto por usuário nos três (429 + `Retry-After`). Sem VAPID tudo isso responde **503** em pt-br e nenhum job é enfileirado.
- **Anti-SSRF.** O endpoint é uma URL que o **servidor** vai chamar, então: só `https`, sem credenciais na URL, porta 443 (ou omitida) e nenhum IP resolvido pode ser interno (loopback, privado, link-local incluindo 169.254.169.254, CGNAT, multicast, reservado, IPv4 embutido em IPv6, NAT64 e faixas de documentação). A validação roda na **inscrição** (resolve o nome e olha todos os IPs) e **no envio**, com um `net.Dialer.Control` que recusa o IP já resolvido a cada conexão (vale contra DNS que muda depois da inscrição). O cliente HTTP tem timeout de 10 s, não usa proxy do ambiente e não segue redirecionamentos. A política só é relaxada pela opção de teste `app.Deps.Push.AllowPrivate` (nunca pela configuração). Inscrição bloqueada no envio é apagada.
- **VAPID.** `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (secrets do GitHub de mesmo nome → `write-env` → `.env` → serviço `spook`). As três juntas ligam o push; sem nenhuma ele fica desligado (log informativo), com só algumas o log avisa e fica desligado; chaves malformadas derrubam a partida. O par não deve mudar depois (as inscrições ficam presas à chave pública). O River agora sobe também quando só o push está ligado (sem storage).
- **Instrumentação.** Métricas: `spook.readstate.acks`, `spook.readstate.query.duration` (histograma, s), `spook.mentions.detected`, `spook.push.jobs{result=sent|removed|failed|skipped}`, `spook.push.job.duration` (histograma, s), `spook.notification.dropped{reason}` e `spook.jobs.queue.size{queue="push"}`. Spans: `notification.Ack`, `notification.ReadStates`, `notification.ResolveMentions`, `notification.OnMessage`, `notification.Subscribe/Unsubscribe`, `notification.push`. Cenário `bench/scenarios/read-states.js` (seção em `bench/README.md`); a execução é da Fase B.
- **Testes.** Unitários: parser de menções (e-mails, pontuação, duplicatas, limite de 20, tamanhos), alvos de notificação e quem recebe push, truncamento e montagem do payload, classificação das respostas do push, validação anti-SSRF (IPs, URLs, DNS falso, dialer contra servidor local, sem redirecionamento), service com dublês (ack, menções, `MESSAGE_CREATE`, entrega por resultado, inscrições, rate limit, fila), envio real contra servidor TLS de teste (cifra, TTL, VAPID). Integração (Postgres/Garage reais, WebSocket real, servidor HTTPS de teste como serviço de push): contagem após ler e ao receber, ack parcial/total/regressivo/no futuro, DM, canal sem VIEW_CHANNEL excluído, entrada tardia sem herdar histórico (e paridade da função SQL), teto de 100 e soma por servidor, sem N+1, `READ_STATE_UPDATE` na OUTRA sessão, `READY.read_states`, `mention_ids` no envio/evento/histórico, push (offline recebe com cabeçalhos VAPID/TTL/`Content-Encoding` e corpo cifrado; online e o autor não; mensagem comum não; DM e grupo sim; 410 remove; 503 retenta; endpoint privado recusado na inscrição e no envio; limite de 10, inclusive sob concorrência; 503 sem VAPID; 429).

**Fase 6 (front)**
- **Anexos (`features/attachments`).** A validação do cliente espelha a do servidor (`rules.ts`: 12 tipos, extensão coerente com o tipo, 1 B a 25 MB, nome ≤ 255, 10 por mensagem) com mensagens em pt-br, antes de gastar banda; quem decide continua sendo o servidor (um `.txt` renomeado para `.png` passa no cliente e é recusado com 422 ao enviar a mensagem). O tipo do PUT sai de `resolveContentType`: tipo vazio ou `application/octet-stream` vem da extensão, e `text/csv`/`text/markdown` valem como `text/plain` (o navegador é mais específico que a lista do servidor); um tipo conhecido e proibido (`image/svg+xml`) nunca é "corrigido". `UploadQueue` (classe sem React, injeção de `requestUpload` e `put`) começa a enviar assim que o arquivo é escolhido (3 simultâneos, abaixo dos 30 pedidos/min e 30 pendentes do servidor): pede a URL, faz o PUT por `XMLHttpRequest` com **exatamente** os `headers` devolvidos e progresso, cancela por `AbortSignal` e guarda o id de cada upload. O botão Enviar só habilita quando todos terminaram; arquivo com erro (cliente ou servidor, por status em pt-br) pode "tentar de novo" (pede URL nova) ou ser removido. Texto vazio é permitido com anexo. Se `POST /messages` responde 422 com anexos, os ids viram inválidos (o servidor pode ter apagado o objeto): todos voltam a "erro" com "Envie este arquivo de novo." e o texto digitado é mantido. Trocar de canal descarta os pendentes (a fila é por canal). Entradas: botão (clipe), arrastar e soltar sobre toda a área do canal (só se o arrasto traz `Files`, com contador de `dragenter/leave` para o overlay não piscar) e colar imagem no campo. Sem ATTACH_FILES o botão fica desabilitado com a explicação fixa abaixo do campo, e soltar/colar mostra o aviso em vez de anexar.
- **Renderização.** Imagens usam `thumbnail_url` com fallback para `url` enquanto o thumbnail não chega; o `MESSAGE_UPDATE` substitui a mensagem no cache pelo mesmo caminho de sempre, e como a chave do anexo é o id, o `<img>` não remonta (sem piscar, sem perder a ancoragem de rolagem). O espaço é reservado pela proporção de `width`/`height` (da imagem **original**) ajustada a 400×300 sem ampliar; antes de existirem (ou se o job falhou), uma caixa 256×192 até a imagem carregar e a proporção natural vira a reserva. `object-fit: contain` e nenhuma rotação forçada (o thumbnail ignora a orientação EXIF). Miniatura que falha (URL de 1 h vencida) cai para o original; se esse também falha, aviso com o nome. O visualizador é um diálogo Radix (foco preso, Esc fecha, o foco volta à miniatura clicada) com a imagem original, setas do teclado e botões para navegar entre as imagens **da mesma mensagem** (circular), contador e baixar. Outros arquivos viram cartão (ícone por tipo, nome, tamanho, baixar com `rel="noopener noreferrer"`); áudio e vídeo usam o player nativo (`preload` `none`/`metadata`).
- **Não lidas (`features/notifications`).** Store Zustand `read-state` por canal `{guildId?, lastRead, mentions, unread, latest?}`, alimentada por `READY.read_states` e `GET /users/@me/read-states` (snapshot completo: canal ausente = zero), `READ_STATE_UPDATE` e `MESSAGE_CREATE`. Os agregados (servidor, DMs, título) são **calculados no cliente** a partir dos canais (soma de não lidas limitada a 100 e menções somadas, igual ao servidor), em vez de guardar o `guilds` do GET. `unread` vai até 100 e a UI mostra `99+` (`formatCount`). `MESSAGE_CREATE` de outra pessoa soma 1 em `unread` quando o canal **não está "em dia"** e nunca mexe em `mentions`: o contador de menções é sempre o valor absoluto do `READ_STATE_UPDATE` (somar aqui e ali contaria duas vezes conforme a ordem de chegada). `READ_STATE_UPDATE` define `mentions`, avança o `lastRead` sem regredir e, se o ack de outra sessão avançou o ponto de leitura sem alcançar a mensagem mais nova que este cliente viu (`latest`), pede um GET (agrupado em 300 ms) para saber o `unread` certo; o mesmo GET reconcilia depois de buraco no gateway (`refreshAfterGap`). Canal ou servidor removido limpa as entradas. Substitui o `unread-store` em memória da Fase 4.
- **Quando conta como lido.** `viewing` tem três estados: *em dia* (canal aberto + aba visível + janela com foco + lista no fim), *à vista* (aberto e ativo, mas rolado para cima: conta como não lida, sem aviso) e *longe*. Mensagem de outra pessoa com o canal em dia não soma `unread`, só registra `latest`; o ack automático (`useAutoAck`) sai 400 ms depois quando há algo a acusar (não lidas, menções **ou** `latest` acima do `lastRead`, para o servidor saber que a mensagem vista ao vivo foi lida), nunca repete o mesmo id (mapa por canal), tenta de novo se falhar e reage a foco/visibilidade (`usePageActive`). O ack usa o `mention_count` da resposta (menção que chegou no meio do caminho continua). Abrir um canal sem nada a limpar não gera ack. Minhas mensagens nunca contam (o servidor também não conta). O separador "Novas mensagens" usa o `lastRead` de **quando o canal foi aberto** (fixo enquanto ele fica aberto, para não sumir sob os olhos) e só existe se havia não lidas e o ponto era conhecido; entra na primeira mensagem de outra pessoa depois dele.
- **Indicadores.** Canal com não lidas: nome em negrito + ponto; com menções: contador vermelho. Barra de servidores: barrinha à esquerda (não lidas) e contador vermelho com a soma de menções do servidor. Início: contador vermelho com as mensagens de DM não lidas (toda mensagem de DM vale como menção) ou ponto; item da DM com contador/negrito. `document.title` = `(N) Spook` com o total de menções (inclui DMs), `99+` acima de 99. A mensagem com o usuário em `mention_ids` ganha fundo e borda de destaque e o `@username` dele (sem diferenciar maiúsculas, mesma regra de delimitação do servidor, então e-mails não marcam) vai em `<mark>`. Não há `@everyone`/`@here`.
- **Avisos in-app.** Só DM ou menção direta, nunca minha, nunca com o canal à vista/em dia (`shouldNotify`, pura). Toast Sonner por canal (o id do toast é o canal, então a próxima mensagem atualiza em vez de empilhar) com ação "Abrir" que navega ao canal; título e corpo seguem o formato do push (`Autor (#canal · Servidor)`, texto de 120 caracteres, `📎 arquivo`). Com a aba **oculta** e a permissão de notificação concedida usa `new Notification` (tag = canal, clique foca e navega); isso não duplica o push, que só sai quando não há sessão de gateway (aba aberta, mesmo oculta, = sem push). Se o construtor falhar (Android) cai para o toast. "Silenciar notificações" (`localStorage`, por navegador) desliga toast e `Notification`; contadores seguem.
- **Web push.** `public/sw.js` estático, sem bundler e sem cache offline: `push` lê o JSON de forma defensiva (inválido, vazio ou com tipos errados vira o aviso genérico "Spook", porque o Chrome exige uma notificação visível em todo push), aceita `url` só no formato `/channels/(@me|<id>)/<id>` (senão abre `/`), usa `tag` do canal com `renotify`, ícone e badge `icon-192.png`; `notificationclick` fecha, foca a janela do app já aberta (qualquer uma da mesma origem) e manda `postMessage({type: "spook:navigate", url})`, que `setupServiceWorker` (em `main.tsx`, fora das rotas autenticadas) valida e navega sem recarregar; sem janela, `openWindow`. O registro é no carregamento do app. Em **Configurações → Notificações** (`/settings/notifications`, link no cabeçalho): estados `unsupported`, `needs-install` (iPhone/iPad fora do PWA instalado, detectado antes do `PushManager`, que não existe lá), `server-off` (503 da chave), `blocked`, `inactive`, `active`. Ativar roda direto do clique e pede a permissão **antes** de qualquer espera de rede (o Safari descarta o gesto), depois busca a chave, reaproveita a inscrição do navegador se houver (senão `subscribe({userVisibleOnly: true, applicationServerKey})`) e envia ao servidor; se o servidor recusa (409 do 11º dispositivo, 422), a inscrição recém-criada é desfeita no navegador. Desativar faz `DELETE` e `unsubscribe` (a falha do `DELETE` é ignorada: o 410 do serviço de push limpa depois). Ao entrar na área autenticada o app reenvia a inscrição existente (upsert; repara troca de conta no mesmo navegador) e ao **sair da conta** tira a inscrição do servidor (limite de 2 s; o navegador continua inscrito). `serviceWorker.ready` tem teto de 5 s para a tela não ficar em "Verificando…" se o registro falhou.
- **Servidor de arquivos estáticos.** `webui` passa a mandar `Cache-Control: no-cache` em tudo que não é `/assets/` (o `sw.js` precisa ser revalidado para o navegador enxergar versões novas; o `/assets/` com hash segue imutável) e `Content-Type: application/manifest+json` no `.webmanifest`. O manifest ganhou `id`, `scope`, `orientation` e `categories`.
- **Testes.** Unitários: tamanho humanizado, regras de arquivo, XHR falso (progresso, cabeçalhos, cancelamento, erro), fila de upload (concorrência, cancelar, erros por status, tentar de novo, ordem dos ids), store de read-states (incremento, ack, reconciliação, teto), `shouldAck`, `shouldNotify`, notificação do navegador, destaque de menção, separador, `sw.js` num escopo global simulado (`vm`) e o fluxo de inscrição de push com navegador simulado. Componentes e app inteiro com WebSocket falso (anexos no composer, cartão e visualizador, badges, MESSAGE_UPDATE trocando o thumbnail, READ_STATE_UPDATE, ack ao abrir, toasts, configurações). E2E Playwright (`e2e/attachments-notifications.spec.ts`): imagem gerada com progresso (PUT atrasado por `route`), thumbnail chegando para os dois lados, visualizador, 25 MB e SVG recusados, texto disfarçado de PNG recusado pelo servidor, cartão de arquivo, não lidas (inclusive depois de recarregar), menção com toast e título, DM com silenciar e a inscrição de push com `serviceWorker`/`PushManager` simulados e as rotas de push interceptadas (o E2E não tem VAPID). O job `e2e` do CI agora sobe o Garage pelo Compose (custo baixo) e o E2E local precisa do `S3_ENDPOINT` alcançável pelo navegador (`apps/web/README.md`). Push real, iOS e EXIF ficam em `VALIDACAO-MANUAL.md`.

**Fase 7a — Casca desktop (Tauri 2)**
- **Casca fina.** `apps/desktop/src-tauri` (Tauri 2, `com.dottadigital.spook`, versão em `apps/desktop/package.json`, repetida no `Cargo.toml` e conferida pela CI) só embute o `apps/web` buildado em modo desktop (`vite build --mode desktop --outDir dist-desktop`, para não sobrescrever o `dist` que o backend serve) e expõe capacidades nativas: chaveiro, instância única (`single-instance`), notificações (`notification`), estado da janela (`window-state`) e links externos (`opener`). A guarda de navegação (`nav.rs`) impede o webview de sair do app: qualquer URL fora de `tauri://localhost`/`http://tauri.localhost` (e do Vite em dev) é cancelada e abre no navegador do sistema (só `http`, `https`, `mailto`). Permissões (`capabilities/default.json`) mínimas; CSP restritiva (`connect-src` só para `spook.dottadigital.com` http/ws, `spook-files` e `spook-rtc`; em dev, localhost). Sem auto-update e sem assinatura de código por ora. O `dev`/`build` de `@spook/desktop` chamam o `tauri`, então ficam **fora** do Turborepo (`--filter='!@spook/desktop'` em `pnpm dev|build`, no `verify.sh` e no `ci.yml`): o `ci.yml` nunca compila Rust.
- **Token no chaveiro do SO.** O desktop pede o token com `X-Spook-Client: desktop` (login/cadastro devolvem `token` no corpo) e o guarda via comandos Rust `auth_get_token`/`auth_set_token`/`auth_clear_token` (crate `keyring`, serviço "Spook": Keychain, Credential Manager, Secret Service). `TokenVault` fica atrás do trait `TokenStore` (testável sem chaveiro). **Sem chaveiro** (Linux sem Secret Service) o cofre cai para memória e devolve `persistent: false`; a interface avisa que será preciso entrar de novo. **Nunca** em arquivo claro, `localStorage` ou cookie. O web mantém uma cópia em memória (`desktop/token.ts`) lida de forma síncrona pelas requisições; carregada em `bootstrapDesktop()` antes do 1º render. Requisições levam `Authorization: Bearer` e `credentials: "omit"` (sem cookies). Logout, e 401 em `GET /users/@me`, limpam o chaveiro.
- **URL base da API.** `setApiBaseUrl()` e `setRequestHeaders()` em `packages/shared/src/http.ts` (o mutator do orval prefixa a origem e injeta os cabeçalhos). Produção do desktop: `VITE_API_BASE_URL=https://spook.dottadigital.com` em `apps/web/.env.desktop`; em dev fica vazio e vale o proxy do Vite (agora com `ws: true`). SPA: o Tauri devolve o `index.html` para caminhos desconhecidos, então recarregar e deep links funcionam com o histórico do navegador.
- **Gateway no desktop.** `gatewayConnection()` usa a URL absoluta (`wss://…/api/gateway`), `client: "desktop"` e a estratégia `getTicket` (`POST /api/gateway/ticket` com Bearer → `?ticket=`), pois o WebSocket do webview não manda `Authorization` nem o cookie de outra origem. A `Origin` do webview já é aceita pelo handshake via `SPOOK_ALLOWED_ORIGINS`.
- **CORS da API (`platform/cors`).** O webview tem origem própria (`tauri://localhost` no macOS/Linux, `http://tauri.localhost` no Windows), então a API responde CORS para as origens de `SPOOK_ALLOWED_ORIGINS` (mesma lista do gateway; padrão = as do Tauri) em `/api/*`. O middleware roda **antes** do rate limit (preflight `204` não consome limite; 401/429 também levam os cabeçalhos, e `Retry-After`/`Server-Timing` são expostos). **Sem `Access-Control-Allow-Credentials`**: o desktop não usa cookies, então não há risco de CSRF por outra origem permitida e a web same-origin não muda. Origem fora da lista não recebe cabeçalho algum. `S3_CORS_ORIGINS` (deploy.yml, `.env.example`) ganhou as origens do Tauri, para o upload por URL pré-assinada e a leitura das miniaturas.
- **Notificações.** Sem Web Push nem service worker no desktop (`main.tsx` não registra o `sw.js`; `usePushSync`/logout pulam o push). `showInAppNotification` usa `deps.desktop`: janela sem foco → notificação nativa (`@tauri-apps/plugin-notification`, permissão pedida na 1ª vez; se o SO recusar, cai para o toast); com foco, toast. No desktop o plugin não tem callback de clique; o canal certo abre por uma heurística de foco (ver o bloco "Adicional: volume, porta, teste de microfone, qualidade da tela e casca do app (desktop)"). `/settings/notifications` mostra "Este app usa notificações nativas do sistema".
- **Voz (costura para a 7b).** `desktop/bootstrap.ts` instala `setVoiceEngineFactory(desktopVoiceEngineFactory)`; sem engine nativa a fábrica lança "Voz no desktop ainda não disponível nesta versão" (o controlador mostra o aviso **antes** de pedir token, para não registrar voice state no servidor) e nunca cai no WebRTC do WebView (RF12.2). A 7b registra a engine com `registerNativeVoiceEngine(() => engine)` (`apps/web/src/desktop/voice.ts`) e adiciona comandos Rust em `invoke_handler` de `lib.rs` (módulo irmão de `token`/`nav`).
- **Instaladores e CI (`.github/workflows/desktop.yml`).** Independente do `deploy.yml`. Gatilhos: `workflow_dispatch`, push na `main` filtrado por `apps/desktop`, `apps/web`, `packages` e o próprio arquivo, e tags `desktop-v*` (a tag precisa ser igual à versão do `package.json`; cria **release rascunho**). Matriz: `windows-latest` x64 (NSIS), `macos-latest` arm64 (`aarch64-apple-darwin`, dmg), macOS x64 (cross-compile no runner arm64 com `--target x86_64-apple-darwin`; marcado `experimental`/`continue-on-error` até ser visto funcionando) e `ubuntu-22.04` (desde a 7b, `ubuntu-24.04`) x64 (`deb` + `AppImage`). Nomes `Spook-<versão>-<so>-<arquitetura>.<ext>` com `.sha256` ao lado. Linux depende de `libwebkit2gtk-4.1`, `libayatana-appindicator3`, `libdbus-1` (keyring) etc. O macOS usa assinatura *ad-hoc* (`signingIdentity: "-"`) com entitlements de áudio, câmera e rede e `Info.plist` com as descrições de microfone, câmera e gravação de tela; Windows e macOS **não** têm assinatura/notarização (SmartScreen e Gatekeeper avisam).
- **Testes.** Web: token via `invoke` simulado (guardar/ler/limpar, fallback em memória com aviso), `Authorization` e URL base absoluta, ticket do gateway, `notify()` desktop, tela de notificações, voz recusada sem pedir token, login e logout no desktop. Rust: `TokenVault` com chaveiro falso e `nav::is_internal`. Go: unitários do CORS e integração (preflight, 401, 429, origem não permitida).


**Correções após o teste manual em produção (31/10)**
- **Storage com dois endpoints.** `S3_ENDPOINT` (público) só assina URLs entregues ao navegador, pois a assinatura inclui o host; as operações do servidor (HEAD, GET, PUT, DELETE de anexos e thumbnails) usam `S3_INTERNAL_ENDPOINT` (`http://garage:3900` no Compose, dev e produção; vazio = o público). Falar com o Garage pela Cloudflare levava 403 no HEAD do backend e derrubava o envio de mensagens com anexo.
- **Erros 5xx não vazam detalhes.** Para qualquer status ≥ 500 (exceto o 503 de funcionalidade desligada, que é mensagem de negócio) o corpo traz só "erro interno do servidor"; o detalhe vai para o log. Toda resposta 5xx é logada (método, caminho, duração, `request_id`) e toda resposta leva `X-Request-Id`.
- **Origem de um 503.** O backend só responde 503 para funcionalidade desligada, shutdown ou `/healthz` degradado; limites de taxa são sempre 429 com `Retry-After` (teste). Toda resposta do backend tem `Server-Timing`; um 503 sem ele vem da borda/container fora do ar (por exemplo durante um deploy, que recria o `spook`).
- **Composer otimista.** O campo é limpo no instante do envio; o texto enviado só volta se o envio falhar (junto com o que foi digitado depois), e só os anexos enviados saem da fila.
- **Menção na própria mensagem.** `mention_ids` exclui o autor (não se notifica a si mesmo) e só ele destaca a linha; o `@usuário` no texto é destacado sempre que cita o usuário atual.
- **EXIF no thumbnail.** A orientação EXIF de JPEGs (valores 1 a 8) é aplicada ao thumbnail depois de reduzir, e `width`/`height` do anexo passam a ser as dimensões como o navegador exibe (trocadas nas orientações 5 a 8).

**Fase 7b — Voz, vídeo e tela nativos (Rust)**
- **Pilha e módulos.** `apps/desktop/src-tauri/src/voice/`: `LiveKit Rust SDK` (`livekit` 0.10 + libwebrtc, TLS `rustls-tls-native-roots`) para a sala; `cpal` 0.15 para microfone e alto-falante; `scap` 0.0.8 para tela/janela (ScreenCaptureKit no macOS, Windows Graphics Capture no Windows, portal xdg + PipeWire no Linux); `nokhwa` 0.10 para a câmera (AVFoundation, Media Foundation, V4L2); `jpeg-encoder` (Rust puro) para o vídeo remoto. Camadas: lógica pura testável (`limits`, `mixer`, `resample`, `wire`, `error`, `frames`, `router`, `events`) → dispositivos (`audio`, `screen`, `camera`, `capture`) → `core` (uma sala por vez, sem dependência do Tauri) → `commands` (Tauri). O WebView **nunca** chama `getUserMedia`/`getDisplayMedia`/`RTCPeerConnection` (teste `no-browser-webrtc.test.ts` varre o código de `src/desktop` e instrumenta as APIs em execução).
- **API Rust↔web.** Comandos: `voice_connect({url, token, events})`, `voice_disconnect`, `voice_set_microphone({enabled})`, `voice_set_deafened({deafened})`, `voice_set_camera_enabled({on, options?: {deviceId}})`, `voice_list_screen_sources`, `voice_set_screen_share({on, options?: {sourceId, audio}})`, `voice_list_devices({kind})`, `voice_set_device({kind, id})`, `voice_video_subscribe({trackId, frames, options?: {maxWidth, maxHeight, fps}})`, `voice_video_unsubscribe({trackId})`, `voice_video_ack({trackId})`. O canal `events` (JSON) espelha `VoiceEngineEvents`: `participant-joined/left`, `speakers-changed`, `video-track-added/removed`, `connection-state`, `link-quality`, `local-media`, `devices-changed`, `disconnected {reason}`. Erros chegam como `{kind: connect|media|other, code, device?, message}`; `message` já vem em pt-br com a instrução do SO (macOS: Ajustes do Sistema > Privacidade e Segurança > Microfone/Câmera/Gravação de Tela e Áudio do Sistema; Windows: Configurações > Privacidade e segurança; Linux: grupos de áudio/vídeo e portal) e a engine web a entrega como `VoiceMediaError.userMessage`/`VoiceConnectError`. `sourceId` é `display:<id>`, `window:<id>` ou `portal`.
- **Áudio.** Microfone: cpal na taxa do dispositivo → mono → reamostragem linear → 48 kHz em quadros de 10 ms → `NativeAudioSource` (fila de 100 ms; `try_send` descarta se o consumidor atrasar). Mutar solta o dispositivo (a luz do SO apaga) e usa `mute()` na faixa publicada, então os outros veem "mudo" sem republicar. Reprodução: um `NativeAudioStream` por faixa remota empurra PCM num **mixer** (soma com saturação; fila de no máximo 200 ms por participante, descartando o mais antigo) consumido por **um** stream de saída cpal (reamostrado para a taxa/canais do dispositivo). **Ensurdecer** zera a saída e descarta o que chega. Os streams do cpal moram em threads próprias (CoreAudio não é `Send`). Dispositivo escolhido que sumiu cai para o padrão. Sem alto-falante a pessoa entra e fala, só não ouve (aviso no log). **Cancelamento de eco, redução de ruído e AGC** (`voice/apm.rs`): o `NativeAudioSource` não passa pelo APM do WebRTC (ele só atua no caminho do ADM, que não usamos), então a ponte é manual com `libwebrtc::native::apm::AudioProcessingModule` (já exposto no libwebrtc 0.3.55, sem feature extra nem dependência nativa nova): o **far-end** é o PCM de 10 ms (48 kHz mono) que sai do mixer, entregue por `push_far` dentro do callback de saída do cpal (sem alocar; `try_lock` e, se a captura estiver com o APM, esse quadro de referência é pulado, nunca espera); o **near-end** é cada quadro de 10 ms do microfone, processado por `process_near` na tarefa que alimenta o `NativeAudioSource`, com `set_stream_delay_ms` a cada quadro (dica estimada a cada ~1 s pelos timestamps do cpal, 60 ms sem eles; ver o bloco "Adicional: ruído e eco (desktop)"). Sem reprodução ativa não há far-end e o APM só aplica NS/AGC. Padrão: AEC + NS + AGC ligados (mais o filtro passa-altas); `voice_set_audio_processing({echoCancellation, noiseSuppression: "off"|"standard"|"strong", autoGainControl})` / `voice_get_audio_processing` (o booleano antigo ainda é aceito); o APM não troca configuração em execução, então cada mudança recria o módulo (o AEC reconverge em ~1 s). Na interface, três interruptores no diálogo de dispositivos (método opcional `setAudioProcessing` do `VoiceEngine`; a redução de ruído virou um seletor de 3 níveis, ver o bloco "Adicional: ruído e eco (web)"), persistidos em `localStorage` (`spook:voice-audio-processing`) e reaplicados ao entrar numa chamada. O teste `apm::tests::echo_canceller_removes_a_simulated_echo` prova o efeito sem hardware (medido: **51,5 dB** de redução após convergir; exige > 15 dB; far-end de ruído, near-end = cópia atrasada em 40 ms a 50 %; compara a energia de saída com o APM desligado após convergir). Limites: eco muito atrasado (> ~200 ms, p.ex. Bluetooth com latência alta) ou alto-falante saturando o microfone reduz o ganho; a dica de atraso é estimada, não medida acusticamente.
- **Vídeo local (câmera e tela).** O funil único `VideoOut`: limita o fps (tela 15, câmera 24; configurável de 5 a 30), converte BGRA/RGBA → I420 (libyuv do libwebrtc), reduz para **no máx. 1080p (tela) / 720p (câmera)** sem ampliar e com dimensões pares, publica no `NativeVideoSource` e alimenta a prévia local. A captura abre **antes** de publicar (permissão negada não deixa faixa fantasma). Tela: `max_bitrate` 2,5 Mbps, sem simulcast; câmera: 1,7 Mbps com simulcast. Ids locais fixos `local:camera` e `local:screen` (os remotos usam o SID da publicação).
- **Vídeo remoto → webview.** Sem WebRTC no WebView: `NativeVideoStream` (fila de 1 quadro, o libwebrtc sobrescreve o antigo) → I420 → reduzido a **no máx. 1280x720 e ~15 fps** (`maxWidth`/`maxHeight`/`fps` por inscrição; a prévia local usa 640x360 a 10 fps) → RGBA → **JPEG qualidade 70** → `tauri::ipc::Channel` binário (bytes crus, sem base64). Formato: `[u32 LE: N][N bytes JSON {trackId, participantId, source, width, height, timestamp}][JPEG]` (`wire.rs` ↔ `frame-wire.ts`). **Backpressure por créditos:** no máximo 2 quadros sem `voice_video_ack`; sem crédito o quadro é descartado **antes** de converter/codificar (custo zero), e um crédito perdido expira em 1,5 s. No webview, se o quadro anterior ainda está sendo desenhado, só o mais novo é mantido (`createImageBitmap` → `<canvas>`) e cada quadro recebido gera exatamente um ack. A conversão só roda enquanto houver `<canvas>` montado (`attach`/`detach` do `VideoSource` inscrevem/desinscrevem; vários hosts compartilham uma inscrição). Escolhido JPEG (e não H.264/WebCodecs) por funcionar igual em WebKitGTK/WKWebView/WebView2 sem depender de decodificador de vídeo do WebView.
- **Câmera como feature Cargo.** `camera` (padrão ligada) isola o `nokhwa`, o ponto mais frágil da build; `cargo build --no-default-features` compila sem câmera e `voice_set_camera_enabled(true)` responde `unsupported` com mensagem clara. O `nokhwa` entra sem o decodificador MJPEG nativo (que exigiria mozjpeg/nasm na CI): quadros MJPEG são decodificados pelo crate `image`. No macOS a permissão da câmera é pedida pelo `nokhwa_initialize` na thread da câmera.
- **Tela.** O `scap` só tem `get_next_frame()` bloqueante: a parada é cooperativa (flag + espera de até 1,5 s; se o backend estiver parado esperando quadro, a thread termina no próximo quadro e fica registrado). No Linux o `scap` não enumera alvos: a lista devolve uma entrada `portal` e quem escolhe é o seletor do desktop (xdg-desktop-portal), então a interface pula o diálogo próprio. Pânicos do `scap` (portal recusado, alvo inválido) são contidos (`catch_unwind`) e viram `cancelled`/`unknown`. **Áudio do sistema: não suportado nesta versão** em nenhuma plataforma (`scap` 0.0.8 não captura áudio; no macOS exigiria driver virtual ou API nova do SCK, no Windows seria loopback WASAPI): o pedido `audio: true` é aceito e ignorado, e o vídeo é compartilhado normalmente.
- **Segurança e robustez.** Sem `unwrap` em caminho de execução (erros viram `VoiceError`); `voice_connect` valida esquema da URL e formato do JWT e o token nunca é logado nem ecoado em mensagens; um canal de voz por vez (conectar de novo encerra a sala anterior); ao desconectar param as threads de áudio/captura, as inscrições de vídeo e o mixer. A desconexão iniciada pelo servidor (`removed`, `network`) emite `disconnected` com o motivo e limpa tudo; a reentrada continua a cargo do controlador existente.
- **Plataformas e CI.** O `libwebrtc` (via `webrtc-sys`) é baixado pré-compilado e **no Linux exige clang >= 21** (libc++ hermético): o workflow instala o LLVM 21 do apt.llvm.org e exporta `CC`/`CXX`/`LIBCLANG_PATH`. O Linux passou de `ubuntu-22.04` para **`ubuntu-24.04`** porque o `pipewire-rs` 0.8 (via `scap`) não compila com o libspa 0.3.48 da 22.04; consequência: `.deb`/AppImage pedem glibc >= 2.39 (Ubuntu 24.04+, Debian 13+, Fedora 40+). Dependências extras no Linux: `libasound2-dev`, `libpipewire-0.3-dev`, `libspa-0.2-dev`, `libgbm-dev`, `libdrm-dev`, `libv4l-dev`, libs X11/xcb e `protobuf-compiler`. macOS: `minimumSystemVersion` subiu para 12.3 (ScreenCaptureKit); `NSMicrophoneUsageDescription`, `NSCameraUsageDescription` e `NSScreenCaptureUsageDescription` já estavam no `Info.plist`; a permissão de gravação de tela (TCC) é por identidade do binário e, com assinatura ad-hoc, pode ser pedida de novo a cada build. Windows: o MSVC e o LLVM dos runners bastam. `timeout-minutes` subiu para 90 (a 1ª build sem cache compila o SDK inteiro). O `ci.yml` continua sem compilar Rust.
- **Testes.** Rust (Docker, ubuntu 24.04): unitários de mixer, reamostragem, quadros de 10 ms, limitador de fps/resolução, créditos/backpressure, formato do quadro, conversão BGRA/RGBA→I420→JPEG (cores e dimensões), roteador, mapeamento de erros e eventos, validação de comandos; **integração `#[ignore]` contra o LiveKit do Compose** (`tests/livekit_integration.rs`, sem dispositivos: o núcleo troca microfone/câmera/tela por tom + barras de cor via `use_synthetic_inputs`): o núcleo publica e um participante do SDK confere o tom e os JPEGs; um participante publica e o núcleo entrega áudio no mixer e JPEGs no canal; mute/unmute, ensurdecer, backpressure, desinscrever, `disconnect` idempotente, um canal por vez, token inválido. Web: engine nativa com `invoke`/`Channel` simulados (todos os métodos e eventos, backpressure, erros mapeados por SO), decodificador de quadros, diálogo de fonte de tela e a varredura "sem WebRTC do navegador".

---

**Adicional: ruído e eco (web)** (qualidade de vida, fora das fases; o desktop/Rust segue o mesmo modelo)
- **Modelo de configuração único (web e desktop).** `AudioProcessingOptions = { echoCancellation: boolean; noiseSuppression: "off" | "standard" | "strong"; autoGainControl: boolean }` em `features/voice/engine.ts`, guardado em `localStorage` (`spook:voice-audio-processing`, por navegador). O valor antigo (booleano) migra ao ler: `true` vira `"standard"` e `false` vira `"off"` (e é regravado no formato novo); qualquer valor inválido volta ao padrão (eco e ganho ligados, ruído em `"standard"`). A engine declara o que sabe fazer por `VoiceEngine.audioCapabilities?: { strongNoiseSuppression: boolean; strongUnavailableReason?: string }`; o diálogo só desabilita o "Forte" quando a engine diz que não tem (e mostra o `strongUnavailableReason`, ex.: "indisponível neste navegador" na web), sem detectar ambiente. Novo evento opcional `audio-processing-status` (`{level, state: idle|loading|active|degraded, reason?, load?: ok|high}`), emitido pela engine web; o controlador o guarda em `useAudioStatusStore` e, em `degraded`, grava o nível rebaixado (não insiste a cada chamada) e avisa com um toast.
- **Três níveis.** *Desligada*: `noiseSuppression: false` e `voiceIsolation: false` no `getUserMedia`. *Padrão*: o filtro do navegador (`noiseSuppression: true`) mais `voiceIsolation: true` (best-effort: navegador que não conhece a constraint a ignora). *Forte (IA)*: RNNoise rodando num `AudioWorklet`, acoplado ao track com `track.setProcessor(...)`, com o filtro do navegador DESLIGADO (não processar duas vezes) e eco/ganho conforme os interruptores. Trocar de nível, eco ou ganho durante a chamada reinicia só a captura do microfone (`restartTrack`) e acopla/solta o processador; a sala não é tocada. Com o microfone mudo não há captura a reabrir: o track é descartado (`unpublishTrack`) e a próxima ativação já captura com as opções novas.
- **Decisão: RNNoise, não DeepFilterNet3.** Comparação: (1) *Licença*: RNNoise é BSD-3-Clause (Xiph.Org/Mozilla/Amazon); o pacote que o empacota para a web, `@sapphi-red/web-noise-suppressor` 0.4.1, é MIT e embute `rnnoise-wasm` (shiguredo, Apache-2.0); DeepFilterNet3 (Rikorose) é MIT/Apache-2.0, e o pacote npm que o expõe ao livekit-client (`deepfilternet3-noise-filter` 1.3.0, `(Apache-2.0 OR MIT)`) também é compatível. (2) *Assets*: o pacote do RNNoise traz TUDO dentro do tarball (worklet 64 kB + WASM 153 kB, ou 157 kB na versão SIMD; o navegador baixa só um) e o Vite os emite como arquivos com hash do próprio build, servidos pelo próprio app; o pacote do DeepFilterNet3 **não inclui** o WASM nem o modelo: por padrão busca `df_bg.wasm` e `DeepFilterNet3_onnx.tar.gz` em um CDN de terceiros (`cdn.mezon.ai`), que respondeu 403 na verificação. Dependeríamos de um binário compilado por terceiros sem origem verificável e de um CDN fora do nosso controle (privacidade, disponibilidade e CSP), e teríamos de reconstruir o WASM a partir do repositório original. (3) *Qualidade percebida*: o DeepFilterNet3 costuma soar melhor (menos "pumping" e melhor com ruído não estacionário), mas o RNNoise, usado em produção pelo Jitsi e por vários clientes de chamada, remove bem ventilador, ar-condicionado, teclado e TV baixa; a voz fica ligeiramente mais "seca" com ruído alto. (4) *CPU*: o RNNoise é leve (~1,4% de UM núcleo de um M2 em Node/WASM: 8 s de áudio em 114 ms); o DeepFilterNet3 é uma ordem de grandeza acima (rede maior, ONNX via tract em WASM) e pesa em notebook básico. Por isso: RNNoise agora; DeepFilterNet3 fica como evolução possível se o dono preferir qualidade a CPU e aceitar hospedar o WASM e o modelo construídos a partir do repositório original (o ponto de troca é `noise-processor.ts`, que só expõe o formato de processador de track). O pacote do RNNoise também traz o GTCRN (MIT, WASM de 197 kB), um candidato intermediário a testar. **Origem dos assets:** `node_modules/@sapphi-red/web-noise-suppressor/dist/{rnnoise/workletProcessor.js,rnnoise.wasm,rnnoise_simd.wasm}`, copiados pelo build (`?url`) para `dist/assets/`; nenhum CDN em runtime.
- **Carregamento sob demanda.** `noise-processor.ts` (e a lib) só são importados (`import()`) quando o nível Forte é aplicado a um track; o bundle inicial só ganhou o código de interface e da engine (~10 kB em `index`). Total baixado ao ativar: ~225 kB (≈150 kB com gzip) na primeira vez, cacheado pelo navegador (`/assets/`, `immutable`). O AudioContext do processador é criado a 48 kHz (o RNNoise exige quadros de 480 amostras a 48 kHz). Requisitos de CSP, se algum dia houver: `script-src 'wasm-unsafe-eval'` (compilar WASM) e `worker-src`/`script-src 'self'` para o worklet.
- **Fallback automático para "Padrão", com aviso.** A engine rebaixa (volta ao filtro do navegador, recapturando o microfone, e emite `degraded` com o motivo) quando: o navegador não tem `AudioWorklet`/`WebAssembly`/`MediaStreamAudioDestinationNode` (capacidade `strongNoiseSuppression: false`: o seletor já nasce desabilitado, e um valor "strong" salvo é rebaixado na entrada da chamada); o download ou a inicialização do modelo falha ou passa de 20 s; ou o processamento não acompanha o tempo real. Esta última é medida por `LoadMonitor`: o navegador não expõe o tempo de CPU do worklet, mas, se a thread de áudio não dá conta, o relógio do `AudioContext` anda menos que o relógio de parede; a cada 2 s compara os dois (razão < 0,9 = janela lenta): uma janela lenta mostra "carga alta" no diálogo e 3 seguidas (6 s) rebaixam. Contexto suspenso não conta.
- **Interface.** O diálogo "Dispositivos de áudio e vídeo" ganhou a seção "Qualidade do microfone": grupo de rádio nativo (teclado e leitor de tela) com *Desligada / Padrão / Forte (IA)* e a descrição de cada um (`aria-describedby`), uma linha `aria-live` com o que está ativo ("Desligada…", "Padrão do navegador…", "Carregando o modelo de IA…", "Processando com IA.", "…no limite: o áudio pode falhar", ou o motivo do rebaixamento) e os interruptores de eco e ganho, com a explicação de que a IA usa mais processador e de que fones evitam o eco. Aparece para qualquer engine que implemente `setAudioProcessing` (web e desktop).
- **Eco: compartilhar tela.** O eco clássico é o áudio da tela/sistema carregar a voz dos outros, que então se ouvem de volta. Agora o botão de compartilhar abre `ScreenShareDialog` com "Incluir áudio" DESLIGADO por padrão (a escolha é lembrada em `spook:voice-screen-share`), o texto sobre eco, a orientação de que compartilhar **uma aba** com áudio é o jeito sem eco e de que, com tela inteira ou janela e áudio, é preciso usar fones. Opções do `getDisplayMedia` (`screenShareOptions`): `selfBrowserSurface: "exclude"` (não oferece a aba do Spook, que realimentaria a chamada); `systemAudio: "include"` só com áudio e `"exclude"` sem; `suppressLocalAudioPlayback: true` sempre; com áudio, `audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: true, restrictOwnAudio: true }` (`restrictOwnAudio` tira do capturado o som da própria aba, isto é, a chamada). Achado: o `livekit-client` 2.23.0 declara `suppressLocalAudioPlayback` no nível superior de `ScreenShareCaptureOptions` mas NÃO o repassa ao `getDisplayMedia` (só `audio`, `video`, `controller`, `selfBrowserSurface`, `surfaceSwitching`, `systemAudio`, `preferCurrentTab`), por isso ele também vai dentro de `audio`. Navegadores que não conhecem uma opção a ignoram, sem erro. O contrato `setScreenShareEnabled(on, {audio})` não mudou; o controlador agora usa a escolha do diálogo em vez de pedir áudio sempre (no desktop, o áudio do sistema também começa desligado).
- **Aviso de risco de eco.** Só texto de orientação, sempre visível. Como reforço, se "Incluir áudio" está ligado e o NOME da saída de áudio escolhida (`echo-risk.ts`) sugere caixa de som, monitor ou TV, aparece um aviso a mais; nome que sugere fone, saída "Padrão do sistema" ou sem nome não mostram nada (o nome não prova nada, e o navegador não revela o nome da saída padrão).
- **Desktop (Rust).** Implementado; ver o bloco "Adicional: ruído e eco (desktop)" logo abaixo.
- **Testes.** Migração do valor antigo, constraints por nível e combinação, recaptura sem desconectar (ligado e mudo), IA acoplada/solta, fallback (sem suporte, falha, timeout, lentidão), `LoadMonitor`, opções do `getDisplayMedia`, diálogo (rádio por teclado, descrições, desabilitado por capacidade, rebaixamento), diálogo de compartilhar, persistência; e `noise-dsp.test.ts`, que roda o **worklet e o WASM reais** do RNNoise num contexto `vm` (sem navegador) com voz sintética (harmônicos de ~130 Hz com formantes e envelope silábico) + ventilador + cliques de teclado: o ruído cai ~12 dB e a energia da voz fica a 0,0 dB da voz limpa (exige > 8 dB e < 3 dB). Não prova a qualidade com voz humana real nem o custo de CPU no navegador (ver `VALIDACAO-MANUAL.md`, "Adicionais").
- **Licenças das dependências novas.** `@sapphi-red/web-noise-suppressor` 0.4.1 (versão exata): MIT; embute RNNoise (BSD-3-Clause, Xiph.Org/Mozilla/Amazon) e `rnnoise-wasm` (Apache-2.0). Nenhuma outra dependência.

**Adicional: volume por pessoa, teste de microfone e qualidade da tela (web)** (qualidade de vida, fora das fases; o desktop/Rust implementa depois, sobre o contrato abaixo)
- **Volume por pessoa.** Controle local (só quem ouve é afetado) por participante da MESMA chamada: botão "Volume de <nome>" na lista de conectados (barra lateral, painel da chamada e canal de voz) e no tile de vídeo em destaque; abre um painel com o volume da **voz**, o volume do **áudio da tela** (só se a pessoa compartilha) e "Silenciar só para mim" (o volume anterior não se perde). Persistido em `localStorage` (`spook:voice-participant-volumes`, por id de usuário, só as entradas diferentes do padrão), reaplicado ao entrar na chamada, quando a pessoa entra na sala (`participant-joined`) e quando ela (re)publica a faixa (a engine guarda o valor por identidade). Contrato: `VoiceEngine.setParticipantVolume?(identity, "voice" | "screen", volume)` e `audioCapabilities.participantVolume?: { max }` (1 = 100%); a interface se adapta ao `max` e esconde os controles quando a capacidade falta. O "silenciar" é calculado no controlador (`effectiveVolume`: silenciado = 0), então a engine só conhece volumes.
- **Decisão: máximo de 100% na web (`max: 1`).** O `livekit-client` 2.23.0 aplica `RemoteParticipant.setVolume(v, source)` em `HTMLMediaElement.volume`, que só aceita 0 a 1 (acima disso lança `IndexSizeError`); ir a 200% como o Discord exigiria `webAudioMix` (todo o áudio remoto passando por `AudioContext`/`GainNode`). Isso tira a reprodução do caminho de `<audio>` que o cancelamento de eco do Chrome usa como referência (histórico de bugs: o AEC não enxerga o áudio roteado por WebAudio de MediaStream remoto, e a lib ainda precisa de um elemento mudo "âncora" para o Chrome decodificar o stream), exatamente o problema que o adicional de eco acabou de resolver. Como não há como validar isso sem hardware, ficou em 100% e o painel avisa "O volume vai até 100% neste navegador". O contrato aceita `max > 1` (o desktop mixa em Rust e pode ir a 200% sem WebAudio). Detalhe da lib: `RemoteParticipant.setVolume` aplica o valor guardado ao assinar uma faixa só se ele for diferente de zero; por isso a engine reaplica o volume também ao assinar (volume 0 inclusive).
- **Deafen x silenciar só para mim.** Independentes: ensurdecer mexe em `muted` dos elementos de áudio e "silenciar só para mim" em `volume`; ensurdecido continua tudo mudo (o painel avisa), e desensurdecer não reativa quem foi silenciado só para mim.
- **Medidor, teste e sensibilidade (porta de ruído).** Diálogo de dispositivos, seção "Teste do microfone". **Medidor** (`role="meter"`, escala -80 a 0 dBFS, marca do limiar no modo manual, "Porta aberta/fechada"): alimentado pelo evento `input-level` `{ db, gateOpen }` de QUALQUER engine; só liga sozinho se já há permissão do microfone (ou o microfone está aberto na chamada), senão espera o clique em "Ativar medidor de nível" (não pede o microfone ao abrir o diálogo). Mede o sinal PÓS-supressão, que é o que a porta enxerga. Em chamada com microfone aberto usa a faixa real (um processador só de medição entra no mesmo grafo); fora dela, ou mudo, usa uma captura de teste separada (`MicPipeline`, `mic-test.ts`) com o MESMO processamento (constraints de eco/ganho/ruído, RNNoise e porta). Qualquer mudança de opção reconfigura/recria a captura de teste. **Testar** (`MicTester`): grava ~5 s do microfone já processado (`MediaRecorder`), fecha o microfone e reproduz a gravação no alto-falante escolhido (`setSinkId`), com contagem regressiva e estados "pedindo permissão / gravando / reproduzindo / concluído / erro" numa região `aria-live`; nunca reproduz o microfone ao vivo. Com o microfone aberto na chamada o botão fica desabilitado (a gravação tocaria para todos): é preciso silenciar antes.
- **Algoritmo da porta (`gate-worklet.js`, AudioWorklet).** Depois da supressão, no MESMO `AudioContext`/grafo (`MicTrackProcessor`: microfone → [RNNoise só no "Forte"] → porta → faixa processada; o livekit-client só aceita UM processador por track). Detector: potência suavizada (um polo, ~10 ms) do canal 0. **Lookahead de 10 ms** (o áudio sai atrasado, então a porta abre antes de o início da palavra chegar à saída: não corta a primeira sílaba), attack 5 ms, **hold 200 ms**, release 80 ms, com o ganho como rampa LINEAR (sem degraus: sem cliques), histerese de 4 dB (abre acima do limiar; só fecha abaixo de limiar-4 dB depois do hold). **Manual:** limiar fixo de -80 a -20 dB (padrão -50). **Automático:** limiar = piso de ruído + 12 dB (limitado a -65..-25 dB), com o piso por estatística de mínimos (desce a 30 dB/s, sobe a 6 dB/s com a porta fechada e a 2 dB/s com ela aberta, para a fala não puxar o piso e um ruído novo e constante, como um ventilador, acabar sendo aprendido em ~10 s). **Desligada:** só mede (o áudio passa, atrasado em 10 ms, com ganho 1). Vale para qualquer nível de supressão (inclusive "Desligada"); trocar modo/limiar durante a chamada manda uma mensagem ao worklet (sem recriar o grafo nem recapturar o microfone); trocar entre "Forte" e outro nível recria o grafo (o RNNoise é fixo na vida do processador). Persistência: `AudioProcessingOptions.inputSensitivity` em `spook:voice-audio-processing` (valor antigo, sem o campo, migra para `off`). Falha ao subir o worklet: segue sem a porta e o diálogo avisa (`gateError`).
- **Qualidade da tela.** `ScreenShareDialog` ganhou "Qualidade" (só se `audioCapabilities.screenShareQuality`; sem ela o diálogo diz com honestidade que a qualidade é automática): presets **Nitidez 1080p 15 fps** (padrão), **Equilibrado 1080p 30 fps**, **Fluidez 720p 60 fps** e **Alta 1440p 30 fps**, mais "Opções avançadas" (resolução 720/1080/1440, fps 15/30/60, prioridade nitidez x fluidez). Mapeamento (`web-engine.ts`): captura = `resolution { width, height, frameRate }` + `contentHint` (`detail`/`motion`); publicação = `screenShareEncoding { maxBitrate, maxFramerate }` + `degradationPreference` (`maintain-resolution` para nitidez, `maintain-framerate` para fluidez). Estimativa de subida mostrada ao usuário (teto, kbps por camada principal): 720p 15/30/60 = 1,5/2/3,5 Mbps; 1080p = 2,5/5/8 Mbps; 1440p = 4/7/12 Mbps (os de 720p/1080p até 30 fps são os do livekit-client). Qualquer preset acima do padrão mostra o aviso de custo (CPU e internet de quem transmite, banda do servidor). Escolha persistida em `spook:voice-screen-quality`. **O padrão é o que o app já fazia** (o `h1080fps15` do livekit-client, 2,5 Mbps): quem não mexe não muda de comportamento. **Custo no servidor:** o LiveKit é um SFU, não recodifica; a CPU do VPS (1 vCPU) não cresce com a qualidade, mas a banda de SAÍDA cresce com bitrate x número de espectadores (1440p30 = 7 Mbps por espectador no pior caso), por isso só presets explícitos passam do padrão. Simulcast fica no padrão da lib (a camada baixa serve quem tem rede ruim; o `dynacast` desliga as camadas que ninguém assiste).
- **Picture-in-Picture.** Botão "Janela flutuante" nos tiles de câmera/tela de OUTRA pessoa, só quando `audioCapabilities.pictureInPicture` (web: `document.pictureInPictureEnabled` e `requestPictureInPicture`; Firefox e navegadores sem a API não mostram o botão). O PiP usa um `<video>` PRÓPRIO, montado fora da tela com a mesma fonte do tile (`pip.ts`), e não o do tile: assim clicar para destacar outro tile (que remonta o tile) não fecha a janela. Fecha sozinho quando a faixa termina, quando a pessoa para a câmera/tela e quando a chamada acaba; o botão é um botão nativo (teclado, `aria-pressed`) e falha vira aviso. **Desktop:** o vídeo remoto é um `<canvas>` (JPEG do Rust); um `canvas.captureStream()` num `<video>` oculto poderia habilitar o PiP, mas isso não é confiável nos WebViews (WKWebView e WebView2 divergem no PiP de `captureStream`), então o desktop declara `pictureInPicture: false` e a interface não promete nada.
- **Contrato para o desktop (Rust).** Implementado no app nativo (ver o bloco "Adicional: volume, porta, teste de microfone, qualidade da tela e casca do app (desktop)" logo abaixo); a descrição a seguir é o contrato original, que dizia que nada disto existia ainda no app nativo; `native-engine.ts` declara `inputSensitivity: false`, `micTest: false`, `screenShareQuality: false`, `pictureInPicture: false` e não declara `participantVolume`, e a interface esconde/explica cada um. Para ligar: (1) `participantVolume: { max: 2 }` + `setParticipantVolume(identity, "voice" | "screen", volume)` → comando `voice_set_participant_volume({ identity, source, volume })` (ganho por participante no mixer do Rust, onde ir a 200% é só multiplicar com saturação; `source: "screen"` para a faixa de áudio de tela quando o Rust passar a captar); (2) `inputSensitivity: true` e `AudioProcessingOptions.inputSensitivity = { mode: "off" | "auto" | "manual", thresholdDb }` em `voice_set_audio_processing` (hoje a ponte só encaminha os três campos antigos; o novo vai junto quando o Rust aceitar), com a mesma porta (attack/hold/release/lookahead/histerese acima) depois do NS; (3) medidor: `voice_set_input_level_monitor({ enabled })` e o evento do canal `{ type: "input-level", db, gateOpen }` (~20 por segundo, dBFS pós-NS; vira `input-level` no `VoiceEngine`); (4) `micTest: true`: `voice_start_mic_test` (grava ~5 s do microfone processado e toca no alto-falante escolhido) / `voice_cancel_mic_test`, com eventos `{ type: "mic-test", phase: "requesting" | "recording" | "playing" | "done" | "error", remainingMs?, error? }`; (5) `screenShareQuality: true` e `setScreenShareEnabled(on, { audio, quality: { height: 720 | 1080 | 1440, fps: 15 | 30 | 60, priority: "detail" | "motion", maxBitrateKbps? } })` (a tabela de bitrates por altura x fps está em `screen-quality.ts`); (6) `pictureInPicture` continua `false`.
- **Testes.** `noise-gate.test.ts` roda o **worklet real da porta** num contexto `vm` (como o `noise-dsp.test.ts`) com ruído branco e "voz" sintética: fecha com ruído abaixo do limiar, abre com voz acima sem perder nível, o início da palavra sai inteiro (lookahead), hold de ~200 ms e fechamento depois, sem cliques (o maior salto entre amostras não passa do que a própria voz tem), limiar trocado por mensagem, modo desligado só mede, e o automático aprende o piso, acompanha um ventilador mais alto e continua deixando a voz passar. Mais: `MicTrackProcessor` (grafo e mensagens), `MicTester` (fases, contagem regressiva, cancelar, erro de permissão), engine web com `livekit-client` simulado (volume por pessoa inclusive 0 e republicação, processador compondo RNNoise e porta, reconfigurar sem recapturar, medidor em chamada, mapeamento de qualidade), persistência e migração, diálogos (rádio por teclado, deslizante, `aria-live`, capacidade ausente = sem controles), PiP simulado (abrir/fechar, faixa que termina, chamada que acaba, recusa, fonte `<canvas>`) e volume na lista de conectados (`voice.test.tsx`). **Não provado:** a qualidade com voz e microfone reais, o efeito do Chrome com `degradationPreference` e o PiP em navegador real (`VALIDACAO-MANUAL.md`, "Adicionais").

**Adicional: ruído e eco (desktop)** (qualidade de vida, fora das fases; mesmo modelo de configuração do bloco web)
- **Contrato.** `voice_set_audio_processing({ echoCancellation, noiseSuppression: "off" | "standard" | "strong", autoGainControl })` e `voice_get_audio_processing` devolve o mesmo formato (camelCase). O formato antigo (`noiseSuppression` booleano) ainda é aceito: `true` vira `standard`, `false` vira `off` (desserialização própria de `NoiseSuppressionLevel`, coberta por teste). `native-engine.ts` envia o nível em texto e declara `audioCapabilities = { strongNoiseSuppression: true, screenShareAudio: false }` (o diálogo habilita o rádio "Forte" sozinho). `screenShareAudio` é uma capacidade nova e opcional (ausente = sim): quando `false`, o diálogo de compartilhar tela não mostra "Incluir áudio" e explica que só a imagem vai.
- **Três níveis.** *Desligada*: NS do APM desligado. *Padrão*: NS do APM do libwebrtc (como antes). *Forte*: NS do APM DESLIGADO e RNNoise nativo no lugar. AEC e AGC seguem os interruptores próprios em todos os níveis; o filtro passa-altas do APM fica sempre ligado.
- **Ordem do pipeline** (`voice/apm.rs`, `ApmBridge::process_near`): microfone cru → **AEC** (precisa do microfone cru e do far-end) → NS do APM (só Padrão) e AGC → **RNNoise** (só Forte) → `NativeAudioSource`. Trocar para/de Forte NÃO recria o APM (a chave do APM é só AEC/AGC/NS-Padrão), então o AEC não reconverge; o RNNoise liga/desliga com crossfade de 10 ms. Trocar AEC, AGC ou entrar/sair do Padrão recria o APM (~1 s de reconvergência, como antes).
- **RNNoise: `nnnoiseless` 0.5.2** (versão exata, `default-features = false`). Port em Rust puro do RNNoise do Xiph.Org; licença **BSD-3-Clause**; pacote de ~130 kB (modelo embutido no código); sem libclang nem código nativo, compila em Windows/macOS/Linux; dependências transitivas novas todas em Rust puro (lista abaixo, em "Licenças"). Módulo puro `voice/rnnoise.rs` (`Denoiser`): quadros de 480 amostras a 48 kHz mono, conversão `i16`→`f32` na escala ±32768 (a que o RNNoise espera) e de volta com saturação; o **primeiro quadro** (aquecimento do modelo) é processado e DESCARTADO (sai o original), e o efeito entra em fade-in linear de 10 ms; ligar/desligar usa o mesmo crossfade seco/molhado; totalmente desligado o estado do modelo é liberado e nada roda (zero CPU); quadro de tamanho errado devolve `false` sem tocar nem entrar em pânico. Caminho quente sem alocação: só os dois buffers de 480 `f32` do struct e arrays fixos internos do `nnnoiseless`; a única alocação (`DenoiseState::new`, ao ligar) fica em `configure`, fora do callback do cpal. Atraso algorítmico do RNNoise: ~10 ms.
- **Decisão: `nnnoiseless`, não DeepFilterNet.** (1) *Licença*: `nnnoiseless`/RNNoise BSD-3-Clause; o DeepFilterNet (`libdf`/`deep_filter`, Rikorose) é MIT/Apache-2.0, também permissivo. (2) *Dependências*: o DeepFilterNet em Rust usa `tract` (inferência ONNX) e traz o modelo ONNX (alguns MB, a confirmar) e uma árvore de dependências bem maior (tract, ndarray, rustfft, etc.), sem garantia de compilar limpo nos três SOs nem de caber no `LTO` com `opt-level = "s"` sem testar; o `nnnoiseless` é um crate pequeno e já testado aqui. (3) *CPU*: RNNoise é uma ordem de grandeza mais leve (rede GRU pequena, ~1–2% de um núcleo); o DeepFilterNet3 em `tract` pesa em notebook básico, e o app já roda libwebrtc + codificação de vídeo. (4) *Qualidade*: o DeepFilterNet3 costuma soar melhor com ruído não estacionário; o RNNoise cobre ventilador, ar-condicionado, teclado e TV baixa, que são os casos do dia a dia. Como não foi possível compilar e medir o DeepFilterNet nos três SOs neste ambiente, ele NÃO foi adotado; fica como evolução se o dono preferir qualidade a CPU (o ponto de troca é só `voice/rnnoise.rs`, que expõe `set_enabled`/`process`).
- **Estimativa dinâmica do atraso do eco** (`voice/delay.rs`, puro). Antes: dica fixa de 60 ms. Agora: o callback de saída do cpal grava `playback − callback` (latência de saída), o de entrada grava `callback − capture` (latência de entrada) e o renderizador grava o que sobrou na fila interna (`pending`) antes de ir ao dispositivo, tudo em átomos (`LatencyProbe`, `Relaxed`; sem alocar nem bloquear nos callbacks). A cada 100 quadros de 10 ms (~1 s) `process_near` soma as três parcelas, joga na janela das **últimas 5 medições (mediana, resistente a picos)** e limita a **10 a 400 ms**; medição inválida (NaN/negativa) é ignorada. Sem timestamps nos dois lados: 60 ms (padrão); se só um lado reporta, o outro entra com 30 ms. Trocar de dispositivo zera a medição do lado trocado. O AEC3 ainda estima o atraso sozinho; a dica só acelera a convergência.
- **Opções do APM avaliadas.** O `AudioProcessingModule` do `libwebrtc` 0.3.55 só expõe quatro interruptores (`echo_cancellation`, `gain_control`, `high_pass_filter`, `noise_suppression`) e `set_stream_delay_ms`; não há nível de supressão de eco nem modo de eco móvel configuráveis (o AEC3 roda com os padrões do WebRTC, modo desktop). Mantido: passa-altas LIGADO sempre. Para melhorar além disso seria preciso outra API de baixo nível do webrtc-sys (fora do escopo).
- **Tela.** O desktop NÃO captura áudio do sistema ao compartilhar (limitação documentada), então não existe laço de eco por compartilhamento. O diálogo de compartilhar tela, no desktop, não mostra "Incluir áudio" e diz que só a imagem vai (e por isso não há eco). O eco por vazamento do alto-falante no microfone é tratado pelo AEC.
- **Testes.** `rnnoise.rs`: ruído de ventilador+cliques sozinho cai **55 dB** (exige > 10 dB); voz sintética + ruído sai a ~−0,2 dB da voz limpa (exige ±4 dB); primeiro quadro idêntico ao original e sem saltos; liga/desliga alternado sem descontinuidade; passagem bit a bit quando desligado; estado liberado após o fade-out; tamanhos errados (0, 1, 479, 481, 960) sem pânico; amostras extremas sem estouro; `Denoiser: Send`. `delay.rs`: soma das parcelas, lado ausente, zero medido, mediana ignora picos, acompanha mudança real, limites 10/400, NaN/negativo, reset. `apm.rs`: JSON do nível (texto, booleano antigo, inválido), Forte sem APM, trocar para Forte mantém AEC/AGC e não muda a chave do APM, dica de atraso segue a sonda. `audio.rs`: o renderizador publica a latência de saída e a fila. Web: `native-engine.test.ts` (nível em texto, capacidades) e `screen-share-dialog.test.tsx` (sem opção de áudio no desktop). Não prova a qualidade com voz humana real nem o custo de CPU (ver `VALIDACAO-MANUAL.md`, "Adicionais").
- **Licenças das dependências novas.** `nnnoiseless` 0.5.2 (exata): BSD-3-Clause (derivado do RNNoise, Xiph.Org/Mozilla/Amazon). Transitivas novas (Rust puro; licenças conferidas no crates.io): `easyfft`, `rustfft`, `array-init`, `generic_singleton`, `primal-check`, `num-complex`, `num-integer`, `strength_reduce`, `transpose` (MIT OR Apache-2.0), `realfft` (MIT) e `anymap3` (BlueOak-1.0.0 OR MIT OR Apache-2.0).

**Adicional: responder, editar com ↑ e fixar mensagens** (qualidade de vida, fora das fases; backend + web)
- **Migration `00007_reply_pins.sql` (aditiva).** `messages.reference_id`, `pinned_at` e `pinned_by`, todas `NULL` e sem default (o Postgres não reescreve a tabela; seguro aplicar no deploy com o servidor antigo ainda de pé) e o índice parcial das fixadas. `reference_id` não tem FK de propósito: a original pode ser apagada (soft delete) ou sumir com o canal sem travar nada; a integridade é checada no envio. `down` remove as colunas.
- **Responder.** `POST /channels/{id}/messages` aceita `reply_to` (ID da mensagem) e `mention_reply` (padrão `true`). A original precisa existir, não estar apagada e ser do **mesmo canal**: senão **422** "a mensagem respondida não existe mais, foi apagada ou é de outro canal" (nada é gravado). Com `mention_reply` e outro autor que **vê o canal**, o autor respondido entra em `mention_ids` (contador de menção, destaque e push como um `@` direto; quem responde a si mesmo não se menciona; teto de 20 mencionados, o respondido tem prioridade). A checagem de visibilidade reaproveita `Resolve("@username")` da feature de notificações, então vale a mesma regra do `@` no texto.
- **Payload.** `MessagePayload.reply_to` é `null` ou `{id, author:{id, username, display_name?}, content, has_attachments, deleted}`; `content` truncado a **100 runes** (sem reticências; a UI corta com CSS) e **vazio quando `deleted`** (original apagada depois). `pinned: bool`. O schema de `reply_to` é `oneOf [ReplyPreview, null]` escrito à mão (o huma não gera nullable para objeto). A prévia é montada em **lote** no histórico (uma consulta para todas as originais da página, apagadas inclusive; teste de contagem de consultas igual para 4 e 20 mensagens), por isso `GET /messages` não tem N+1. O MESSAGE_UPDATE da original (edição) **não** republica as respostas: o cliente atualiza o trecho no cache e o histórico recarregado traz o novo.
- **Fixar.** `PUT /channels/{id}/pins/{message_id}` e `DELETE` (204, **idempotentes**: repetir não muda nada nem publica evento). Servidor: exige `MANAGE_MESSAGES` (403 sem ela, 404 sem acesso ao canal); DM: qualquer participante. Máximo **50** fixadas por canal (**409** acima; a checagem e a escrita são um único `UPDATE`, sem corrida; fixar uma já fixada com o canal cheio continua 204). Mensagem apagada ou de outro canal: 404. Apagar uma fixada **desafixa** (some da lista e libera vaga). `GET /channels/{id}/pins` devolve até 50, a mais recentemente fixada primeiro, com o mesmo payload (basta poder ver o canal).
- **Evento.** Fixar/desafixar publica só `MESSAGE_UPDATE` com o payload completo (`pinned` novo); não existe evento de lista. O cliente mantém o painel de fixadas assim: `pinned` verdadeiro entra no topo (ou atualiza no lugar), falso sai, `MESSAGE_DELETE` tira.
- **Observabilidade.** Spans `message.replyTarget`, `message.ListPins`, `message.SetPinned` (atributo `pin`), `message.Send` ganhou `reply`; métricas `spook.messages.replies` e `spook.messages.pin_ops{pin}`.
- **Web: responder.** Ação "Responder" na barra de ações da mensagem (aparece em hover e foco) e atalho **R** com a mensagem focada (as mensagens ganharam `tabIndex=0`, o que também deixa as ações alcançáveis por Tab). O composer mostra "Respondendo a <nome>" com prévia, botão cancelar, **Esc** cancela e um botão "@ ativado/desativado" (`aria-pressed`, padrão ativado a cada resposta; escondido ao responder a si mesmo). Sucesso limpa a resposta; **422** mostra o motivo do servidor e cancela a resposta mantendo o texto; 429 segue a contagem regressiva de sempre. A citação (autor + trecho, "Mensagem original apagada" quando `deleted`) abre um grupo novo na lista (cabeçalho com avatar). Clicar nela rola até a original (centralizada, destaque de 2 s); se não está no cache, carrega até **10 páginas anteriores** procurando e, se não achar, avisa "fora do histórico carregado". Apagar/editar a original atualiza a citação no cache em tempo real. O mesmo mecanismo ("ir até a mensagem", `jump.ts`) serve ao painel de fixadas e ao ↑.
- **Web: ↑.** No campo vazio, ArrowUp (sem Shift/Ctrl/Alt/Meta e fora de composição IME) abre a edição da mais recente mensagem **do próprio usuário** entre as carregadas (não apagada); Esc cancela e Enter salva (a edição já existente); ao terminar o foco volta ao campo. Sem mensagem própria carregada, não faz nada.
- **Web: fixar.** Ação "Fixar/Desafixar" só com `MANAGE_MESSAGES` em servidor (em DM, sempre), alfinete + "fixada" na mensagem e botão "Mensagens fixadas" no cabeçalho do canal/DM, que abre um diálogo (modal, acessível por teclado) com a lista de `GET /pins` (refeita a cada abertura e mantida por MESSAGE_UPDATE), "Ir para a mensagem" e "Desafixar" (com permissão). Erros 403/404/409/422/429 em pt-br (`appMessage`). Atalho **P** na mensagem focada.
- **Não feito (de propósito).** Menu de contexto separado (a barra de ações cumpre o papel); evento de lista de fixadas; resposta em thread; aviso de "mensagem fixada" no canal; fixadas de mais de 50 (limite fixo).
- **Testes.** Go: unitários do service (prévia truncada em runes, menção da resposta com todas as exceções, 422 de originais inválidas, lote de originais em 1 consulta, fixar/desafixar idempotente, permissões, DM, limite de 50 e vaga ao apagar, fixadas) e integração HTTP + WebSocket real (`replies_pins_integration_test.go`: citação, `mention_reply`, DM, original apagada depois, histórico sem N+1, fluxo de fixar com MESSAGE_UPDATE por WebSocket, cargo com MANAGE_MESSAGES, limite de 50, DM e estranho). Web (Vitest + MSW, `replies-pins.test.tsx` e `reply-pins-cache.test.ts`): barra, `reply_to`/`mention_reply` no corpo, interruptor, Esc/cancelar, atalho R, 422, citação clicável (no cache, em páginas anteriores, fora do histórico), DM, ↑ (regras e IME), fixar com e sem permissão, erros, painel (ordem, vazio, ir até, desafixar), eventos do gateway e helpers de cache. E2E Playwright `e2e/replies-pins.spec.ts` (duas contas: responder → citação para os dois lados; fixar → painel; ↑ edita).

**Adicional: status (DND/invisível/personalizado) e silenciar/nível de notificação** (qualidade de vida, fora das fases; backend + web)
- **Migration `00008_status_notifications.sql` (aditiva).** `users.status_pref` (`online|dnd|invisible`, `NOT NULL DEFAULT 'online'`, constante: sem reescrita), `custom_status_text` (até 128), `custom_status_emoji` (até 32) e `custom_status_expires_at`, as três `NULL`; tabela `notification_settings (user_id, scope guild|channel, target_id, muted, muted_until NULL, level NULL all|mentions|none, updated_at)` com PK `(user_id, scope, target_id)`. Sem FK para o alvo (servidor, canal ou DM): linha órfã é inofensiva e o alvo é validado na escrita. `muted=true` sem `muted_until` = "até reativar" (o `muted` booleano existe para não inventar um instante infinito). DMs e DMs em grupo usam `scope=channel`.
- **Status.** "Ausente" segue automático (10 min sem interação, pelo cliente). A pessoa escolhe a **preferência**: online, `dnd` (Não perturbar) ou `invisible`. O que os outros veem: `online | idle | dnd | offline`. **Invisível**: a máquina de conexão (sessões, grace de 15 s, voz) não muda; só a visão pública vira `offline` e sem status personalizado (nem entra no snapshot do READY); a própria pessoa se vê invisível pela preferência (`READY.self_presence` e `PRESENCE_SELF_UPDATE`). **dnd** vale mesmo estando ausente. `Status()` do service continua devolvendo o status de **conexão** (o push decide "tem sessão ativa" por ele, então invisível não recebe push com a aba aberta).
- **Status personalizado.** `{text<=128, emoji<=32, expires_at?}` (texto e/ou emoji; ao menos um). Expiração opções do cliente: não limpar, 30 min, 1 h, 4 h, hoje (o cliente manda o instante absoluto; "hoje" = meia-noite local). O servidor exige `expires_at` futuro e **até 48 h** (422). **Expiração: avaliada no servidor sem job.** Na leitura (`Self`, snapshot, eventos) um status vencido é tratado como inexistente; para o aviso em tempo real há um `AfterFunc` por usuário conectado que republica o `PRESENCE_UPDATE` sem o status no instante do vencimento (a linha do banco fica velha e é ignorada/sobrescrita; não há limpeza periódica). Escolhida por ser a mais simples: a alternativa (job River por usuário) adicionaria escrita no banco e fila sem benefício.
- **API.** `GET /api/users/@me/presence` e `PATCH /api/users/@me/presence` (`status_pref?`, `custom_status?`, `clear_custom_status?`; o que for omitido não muda) → `{status_pref, custom_status?}`. `GET|PUT|DELETE /api/users/@me/notification-settings[/{scope}/{target_id}]`: GET devolve só o que difere do padrão (silêncio vencido sem nível some); PUT substitui (`muted`, `muted_until?` futuro e só com `muted=true`, `level?`) e sem silêncio e sem nível apaga a linha; DELETE é idempotente e 204 (não exige acesso ao alvo, para poder limpar depois de sair). Autorização no backend: `scope=guild` exige ser membro (404), `scope=channel` usa `Authorize` do canal/DM (404/403). ID inválido = 404 (padrão do projeto).
- **Gateway.** `PRESENCE_UPDATE` e `READY.presences[]` ganham `status` `dnd` e `custom_status?`. `READY` ganha `self_presence` e `notification_settings`. Novos eventos para o próprio usuário (tópico `user:<id>`, todas as sessões): `PRESENCE_SELF_UPDATE` ({status_pref, custom_status?}) e `NOTIFICATION_SETTINGS_UPDATE` (a configuração do alvo; resetar publica `muted=false, level=null`). As preferências são lidas do banco no IDENTIFY (`presence.Service.Self`, que também as deixa prontas para o `Connect`, então quem está invisível nunca "pisca" online).
- **Herança do nível e silêncio.** Nível efetivo: canal/DM -> servidor -> padrão (servidor: **só menções**; DM: **tudo**). Silêncio vale se o canal OU o servidor estiverem silenciados; silêncio com `muted_until` no passado deixa de valer sem job (comparação com `now` na leitura e no push). Silenciar e nível só afetam **avisos**: push, toast, notificação nativa do desktop. **A contagem de não lidas e de menções continua** (badges e título do navegador não mudam). Regra do aviso: silenciado nunca; `all` sempre; `mentions` só com menção direta (em DM sem menção explícita, "só menções" não avisa); `none` nunca.
- **@everyone/@here.** Não existem neste projeto (são só usernames, ver Fase 6b), então não há o que suprimir: a regra acima já cobre o que o Discord chama de supressão de `@everyone` (silenciado e "nada" bloqueiam tudo; "só menções" avisa só menção direta).
- **Push e DND.** O push só existe para quem não tem sessão de gateway e só para DMs e menções diretas (inalterado). Agora também é descartado se o destinatário está em `dnd` (lido do banco na mesma consulta) ou se o silêncio/nível do canal/servidor o bloqueia: **uma consulta** (`ListNotifyFilters`) para todos os destinatários, só depois do filtro de sessão ativa. Nível `all` em servidor **não** amplia o push (continuaria só DMs e menções, para não fazer fan-out a todos os membros); ele vale para toasts e notificações nativas do cliente.
- **Cliente.** Rodapé da barra lateral (servidor e DMs): seletor de status (Online, Não perturbar, Invisível) com ponto de cor (verde, âmbar, vermelho, cinza) e diálogo de status personalizado; o custom status aparece na lista de membros, no cabeçalho da DM e no rodapé. Menu do servidor (e botão direito no ícone do servidor), menu "..." do canal de texto e da DM: "Silenciar por..." (15 min, 1 h, 8 h, 24 h, até reativar) / "Reativar" e "Configurações de notificação" (padrão/herdar, tudo, só menções, nada); canal/servidor/DM silenciados ficam com opacidade reduzida e ícone de sino cortado. A página `/settings/notifications` ganhou o cartão "Silenciados e níveis" (padrões e lista do que foi personalizado, com "Restaurar padrão"). DND ligado suprime toast e notificação nativa (`shouldNotify` recebe `dnd`, `level` e `muted`). Não há sons de aviso no app hoje, então não há som a suprimir. Um tick agendado no vencimento do próximo silêncio atualiza os indicadores sozinho.
- **Não feito (de propósito).** Padrão de nível por usuário para todos os servidores (só por servidor/canal/DM), horário agendado de DND, push para "tudo" em servidor, silêncio por categoria, status personalizado no card de perfil (não existe card de perfil), emoji picker completo (há 8 sugestões e campo livre).
- **Observabilidade.** Spans `presence.self`, `presence.update`, `notification.ListSettings`, `notification.PutSetting`, `notification.DeleteSetting` (todo endpoint passa pelo middleware OTel e `Server-Timing` já existentes). Métrica existente `spook.presence.transitions` conta também os novos status.
- **Testes.** Go: unitários de presença (dnd mesmo ausente, invisível sem piscar online/sem offline repetido, `PRESENCE_SELF_UPDATE`, custom status com expiração pelo relógio falso, vencido do banco ignorado, validações), de notificação (herança canal/servidor/padrão, silêncio vencido, push com DND/silêncio/nível, DM "só menções", validações e eventos do PUT) e fixtures do gateway; integração (Postgres real + WebSocket real: dnd/invisível/custom status entre contas e entre abas, persistência no READY, snapshot, CRUD e autorização de configurações, evento entre sessões, push respeitando DND/silêncio/nível/vencido com as contagens crescendo). Web (vitest + MSW): regras puras, seletor de status, diálogo de status personalizado, DND no READY, silenciar DM com indicador e reativar, evento de outra aba, menu de nível, página de notificações. E2E Playwright (`apps/web/e2e/status-mute.spec.ts`).

**Adicional: volume, porta, teste de microfone, qualidade da tela e casca do app (desktop)** (qualidade de vida, fora das fases; implementa o contrato do bloco web acima e a "casca" do app)
- **Resumo da API Rust↔web.** Comandos novos: `voice_set_participant_volume({ identity, source: "voice" | "screen", volume })`, `voice_set_input_level_monitor({ enabled, events? })`, `voice_start_mic_test({ events? })`, `voice_cancel_mic_test()`, `app_get_settings()`, `app_set_settings({ settings })`, `app_set_badge({ count })`. Comandos alterados (compatíveis): `voice_set_audio_processing` aceita `inputSensitivity?: { mode: "off" | "auto" | "manual", thresholdDb }` (ausente = desligada) e `voice_set_screen_share` aceita `options.quality?: { height: 720 | 1080 | 1440, fps: 15 | 30 | 60, priority: "detail" | "motion", maxBitrateKbps? }`. Eventos novos no canal: `{ type: "input-level", db, gateOpen }` e `{ type: "mic-test", phase, remainingMs?, error? }`. `native-engine.ts` passou a declarar `participantVolume: { max: 2 }`, `inputSensitivity`, `micTest` e `screenShareQuality` verdadeiros (`pictureInPicture` segue `false`).
- **Canal de eventos próprio para medidor e teste.** O medidor e o teste valem FORA de chamada, quando não existe o canal da sala (criado em `voice_connect`). Por isso `voice_set_input_level_monitor` e `voice_start_mic_test` recebem um `events` opcional: o `native-engine.ts` cria UM canal próprio na primeira necessidade e o reutiliza; o Rust guarda o último e emite `input-level`/`mic-test` por ele, dentro ou fora da chamada. Desvio do contrato original (`{ enabled }` puro), necessário para o medidor funcionar sem chamada.
- **Volume por pessoa (mixer, `voice/mixer.rs`).** Cada fila do mixer é ligada (`bind`) à pessoa e à origem da publicação (`TrackSource::ScreenshareAudio` = `screen`, o resto `voice`); o ganho fica em (identidade, origem), de 0 a 2,0 (NaN vira 100%, acima de 200% é limitado). Soma em `i32` com saturação final (`clamp` em `i16`). Mudança de ganho entra em rampa linear dentro do bloco de 10 ms (o último quadro já está no alvo): sem estalo. Volume 0 silencia só para mim e a fila continua sendo consumida (nada de áudio velho ao reativar). O ganho persiste enquanto a pessoa está na sala (esquecido em `ParticipantDisconnected` e no próximo `connect`), vale para faixas republicadas (outro `sid`, mesma pessoa/origem) e é independente do ensurdecer. O web reenvia o valor salvo ao entrar. Na UI, o teto é 200% (`ABSOLUTE_MAX_VOLUME`).
- **Porta de ruído (`voice/gate.rs`, pura).** Porta fiel do `gate-worklet.js`: potência suavizada de um polo (~10 ms), lookahead de 10 ms (um quadro), attack 5 ms, hold 200 ms, release 80 ms em rampa linear, histerese de 4 dB; manual (limiar fixo, -90..-5 dBFS, a interface usa -80..-20) e automático (piso por mínimos: desce 30 dB/s, sobe 6 dB/s fechada e 2 dB/s aberta; limiar = piso + 12 dB limitado a -65..-25). Roda no `ApmBridge::process_near` DEPOIS do AEC/NS/RNNoise e antes do `NativeAudioSource`, em qualquer nível de supressão. **Diferença do web:** com a porta `off` o áudio passa INTACTO e sem atraso (o web mantém os 10 ms mesmo desligada); a troca entre `off` e ligada faz crossfade de 10 ms entre o caminho direto e o da porta, sem clique (teste dedicado). O medidor lê o nível do detector (dBFS) e o estado da porta de átomos, sem tocar no `Mutex` do áudio.
- **Medidor e prévia do microfone.** Com o medidor ligado e o microfone da chamada aberto, o nível vem da captura da chamada. Fora disso (sem chamada, ou chamada com o microfone mudo) o núcleo abre uma captura de PRÉVIA do microfone: mesma cadeia (AEC sem far-end quando não há reprodução, NS, porta), sem publicar e sem tocar. A prévia cede o dispositivo quando o microfone entra na chamada ou um teste começa, e volta quando o microfone da chamada é silenciado ou a chamada termina. Um ticker de 50 ms emite o nível só se chegaram quadros novos (sem captura, nada de valores velhos). Trocar o microfone reabre a prévia.
- **Teste de microfone (`voice/mictest.rs` + `core.rs`).** Fases `requesting` → `recording` (aviso a cada 100 ms com `remainingMs`) → `playing` → `done`; erro de dispositivo vira `error` com o código tipado (`permission-denied`, `not-found`, `in-use`...); sem quadros por 3 s vira `error: "unknown"` (não fica gravando para sempre). Grava ~5 s num buffer fixo de 240 mil amostras (`Recorder`, nunca cresce), fecha o microfone, e só então toca no alto-falante escolhido por um `Mixer` próprio alimentado no ritmo do relógio (`Feeder`, 60 ms de antecedência; o mixer guarda no máx. 200 ms). Nunca toca o microfone ao vivo. Com o microfone aberto na chamada o comando devolve o erro tipado `media/in-use` e o `native-engine.ts` o converte no evento `mic-test` `error: "in-use"` (o botão já fica desabilitado na interface). Abrir o microfone na chamada durante um teste o cancela. Cancelar emite `done` (como o web) e solta microfone e alto-falante.
- **Qualidade da tela (`voice/quality.rs`, pura).** Mesma tabela de teto de bitrate do `screen-quality.ts` (720p: 1,5/2/3,5 Mbps; 1080p: 2,5/5/8; 1440p: 4/7/12 para 15/30/60 fps) e mesmo padrão (1080p, 15 fps, nitidez, 2,5 Mbps) quando `quality` falta: quem não mexe não muda de comportamento. Valores fora da lista voltam ao padrão campo a campo; `maxBitrateKbps` é limitado a 300..20000. Mapeamento: captura `scap` a `fps` (o `FpsLimiter` da tela aceita até 60; câmera e vídeo remoto seguem em 30), quadro reduzido no funil para a caixa 16:9 da altura (`1280x720`, `1920x1080`, `2560x1440`; nunca amplia; o `scap` continua em `Resolution::Captured`, sem escalar na captura); publicação com `VideoEncoding { max_bitrate, max_framerate }` e `degradation_preference` (`detail` = `MaintainResolution`, `motion` = `MaintainFramerate`, o análogo do `contentHint` do navegador). Telas muito largas (ultrawide) cabem na caixa 16:9 e saem com menos de 1440 de altura. O custo de CPU de 1440p/60 fps na captura + conversão I420 + codificação VP8 por software pode ser alto e não foi medido.
- **Bandeja do sistema (`shell.rs`).** Feature `tray-icon` do Tauri 2; ícone da marca (o ícone padrão da janela), tooltip "Spook" (ou "Spook (3)"), menu "Abrir Spook" e "Sair"; clique esquerdo alterna mostrar/ocultar. **Fechar vai para a bandeja** (padrão LIGADO): `CloseRequested` é impedido, a janela é escondida e uma notificação única (primeira vez, guardada em `app-settings.json`) avisa "O Spook continua rodando na bandeja". "Sair" e Cmd+Q/último fechamento passam por `request_quit`: desconecta a voz (até 3 s) e encerra. A segunda abertura (single-instance) e o clique no Dock (macOS) trazem a janela de volta. O `tauri-plugin-window-state` deixou de restaurar a VISIBILIDADE (senão sair com a janela escondida faria o app abrir escondido para sempre).
- **Início com o sistema e minimizado.** `tauri-plugin-autostart` (padrão DESLIGADO; macOS Launch Agent, Windows chave Run, Linux `.desktop` em autostart); o item passa `--autostart`. "Iniciar minimizado" (padrão desligado) só vale nessas aberturas (ou com `--minimized`): abrir o app pelo ícone sempre mostra a janela. O arquivo é a fonte da verdade e o autostart é realinhado no boot. `app_set_settings` aplica o autostart ANTES de gravar: se o SO recusar, nada muda e a página mostra o erro. Rota `/settings/app` (link "Aplicativo" e botão em Notificações, só no desktop; na web a rota só explica que não se aplica). As permissões do plugin NÃO foram concedidas ao webview (`capabilities/default.json` inalterado): tudo passa pelos comandos do app.
- **Contador no ícone (`app_set_badge`).** O web já calculava menções + DMs não lidas (título `(N) Spook`); `DesktopShell` envia o mesmo número com debounce de 250 ms (sem repetir valor) e zera ao desmontar. **macOS:** número no Dock (`set_badge_count`). **Windows:** ícone sobreposto na barra de tarefas gerado em código (`badge.rs`: círculo vermelho 32x32 com glifos 3x5 ampliados, "99+" acima de 99; sem arquivo de imagem nem fonte) e tooltip da bandeja. **Linux:** `set_badge_count` só onde o desktop oferece (Unity/lançadores com libunity), tooltip da bandeja não existe no AppIndicator, então o número também vai no título do ícone onde o painel o mostra; na prática, só o título da janela. Zero limpa tudo.
- **Clicar na notificação abre o canal.** O plugin não entrega o clique. `notifier.ts` guarda `{ url, at }` da última notificação nativa; o `DesktopShell` escuta o foco da janela (`onFocusChanged`) e o evento `app://activated` (emitido pelo Rust quando ele próprio traz a janela: bandeja "Abrir", segunda instância, Dock) e, se a notificação tem até `NOTIFICATION_CLICK_WINDOW_MS` (10 s, constante) e não foi usada, navega UMA vez (`router.navigate`) e a esquece; só caminhos `/channels/...` do app passam (`safeAppPath`). **Limitação:** alt-tab para o Spook dentro dos 10 s também navega.
- **Linux e a bandeja.** O ícone exige host de StatusNotifier/AppIndicator: KDE, XFCE, Cinnamon e MATE têm; o GNOME precisa da extensão "AppIndicator and KStatusNotifierItem Support". Sem host o app esconde a janela e não há como reabri-la pelo ícone: desligar "Fechar vai para a bandeja" ou abrir o Spook de novo (a segunda instância traz a janela). O clique esquerdo no ícone não chega ao app no Linux (limitação do AppIndicator): vale o menu. Dependências: o workflow já instala `libayatana-appindicator3-dev`; o `.deb` passou a depender de `libayatana-appindicator3-1 | libappindicator3-1` (o `tray-icon` carrega a biblioteca em tempo de execução e falha sem ela).
- **Testes.** Rust (módulos puros, na crate descartável em `rust:1-slim`): `gate` (fecha com ruído, abre com voz sem perder nível, lookahead, hold ~200 ms, sem clique ao abrir/fechar e ao alternar `off`/ligada, limiar trocado sem recriar, `off` passa intacto, automático aprende o piso e acompanha um ventilador mais alto, amostras extremas, JSON, limites); `mixer` (ganho por pessoa, até 200% com saturação, 0, voz x tela independentes, rampa sem degrau, ganho sobrevive à republicação, esquecer pessoa/sala, deafen independente); `quality` (tabela, padrão, caixa 16:9, prioridade, normalização, JSON); `mictest` (buffer limitado, entrega no ritmo do relógio); `settings` (padrões, JSON, arquivo corrompido, persistência, gravação que falha mantém o valor, aviso único, quando nasce escondida); `badge` (rótulos, ícone). Integração (`apm.rs`, `core.rs`, `commands.rs`, `shell.rs`, `events.rs`): compilada pelo workflow Desktop; em Linux o `shell.rs`/`lib.rs` foram checados com `clippy -D warnings` num contêiner. Web (vitest): `native-engine.test.ts` (capacidades, volume com limites, porta, medidor com canal próprio dentro e fora de chamada, teste e erro `in-use`, qualidade), `shell.test.ts` (debounce do contador, heurística do clique: prazo, uso único, caminho inseguro, desinstalar), `app-settings.test.tsx` (só no desktop, interruptores chamam os comandos, falha mostra erro e reverte, contador do `DesktopShell`). **Não provado:** o áudio real (microfone, alto-falante, 200% de ganho), o `scap` a 60 fps, a bandeja e o badge nos três SOs, o autostart real e a heurística do clique com notificações do SO (`VALIDACAO-MANUAL.md`, "Adicionais").

**Adicional: painel administrativo (/admin)** (fora das fases; backend + web; inspirado no admin do Antrax)
- **Quem é admin.** Coluna `users.is_admin boolean NOT NULL DEFAULT false` (migration `00009_admin.sql`, aditiva; a mesma migration cria o índice `messages (author_id)`, necessário para contar/ordenar usuários por mensagens sem varrer `messages`). A variável `ADMIN_USERNAMES` (usernames separados por vírgula, comparados sem diferenciar maiúsculas) promove no boot (`UPDATE ... WHERE username = ANY(...) AND NOT is_admin`): idempotente, **nunca rebaixa** (para promover ou rebaixar direto no VPS use o subcomando `spook admin grant|revoke <username>|list`, via `deploy/admin.sh` por SSH; vale na hora porque a checagem lê o banco a cada requisição). A conta precisa existir antes do boot; **não** promovemos "quem se cadastrar com esse username" para ninguém reservar um nome de admin por corrida. Em produção a variável vem da Variable `ADMIN_USERNAMES` do GitHub, gravada no `.env` pelo `write-env` e repassada ao container pelo compose (`deploy/README.md` 6.1.1b); em dev, `.env`.
- **Autorização.** Toda rota `/api/admin/**` passa pelo middleware de sessão (401) e por um segundo middleware huma que consulta `users.is_admin` (403 com mensagem genérica "acesso restrito a administradores"; falha do banco vira 500 genérico). O front usa `is_admin` de `GET /users/me` (campo novo em `View`) só para mostrar o link e para a guarda da rota `/admin`; a verificação de verdade é sempre a do backend.
- **API (todas `GET`, huma + OpenAPI + orval).** `/api/admin/overview` (contagens, séries e comparações; cache 30 s), `/api/admin/live` (chamadas ao vivo + uso do LiveKit; cache 5 s), `/api/admin/system` (aplicação, banco, armazenamento, jobs, gateway; cache 5 s, banco 60 s), `/api/admin/users?q=&sort=&order=&page=`, `/api/admin/servers?...` (25 por página; busca por `strpos(lower(...))`, sem `LIKE`, então não há curingas para escapar; colunas de ordenação em lista fixa, qualquer outra é 422) e `/api/admin/calls?q=` (cache 5 s da leitura do LiveKit; o filtro roda em memória). IDs como string.
- **Polling, não SSE.** O web usa TanStack Query com `refetchInterval` de 5 s (ao vivo, chamadas, sistema/gateway) e 30 s (visão geral); o TanStack não consulta com a aba oculta/sem foco. Escolhido pela simplicidade e robustez (sem canal novo no gateway, sem reconexão, passa por qualquer proxy) e porque o cache do servidor limita o custo: N admins abertos não multiplicam as consultas. Cabeçalho mostra "Atualizado em hh:mm:ss" e um ponto de "ao vivo". SSE/gateway só valeria com dezenas de admins ou necessidade de latência abaixo de 1 s.
- **Cache no servidor (`admin/cache.go`).** Um `cell[T]` por agregado: valor com TTL + singleflight (chamadas simultâneas se juntam numa só execução; a carga roda sem o cancelamento de quem pediu, com timeout de 15 s; erro não é guardado). Nenhuma requisição varre tabelas: `messages` total/divisão servidores x DMs e as contagens ficam 30 s; séries 30 s; tamanho do banco e maiores tabelas 60 s. Períodos de mensagens (24 h, 7 dias, série de 14 dias) filtram pela PK (`id >= MinID(t)`, `snowflake.MinID`), já que `messages` não tem coluna de data; o dia vem do Snowflake (`to_timestamp(((id >> 22) + 1767225600000) / 1000.0)`). Listas de usuários e servidores não têm cache (paginadas e filtradas); medido no banco de dev (10 mil usuários, 175 mil mensagens): ordenação padrão ~20 ms, por mensagens ~375 ms.
- **Séries e comparação.** 14 dias UTC terminando hoje, dia sem dado = 0; "últimos 6 dias completos x 6 anteriores" exclui hoje (parcial) e a variação é nula (traço) se o período anterior foi zero. O gráfico é SVG com tabela acessível ("Ver como tabela") e a barra de hoje mais clara.
- **O que a tela mostra do app.** Cartões (usuários com crescimento em 7 dias, servidores e participações, mensagens 7 dias e 24 h, chamadas e pessoas em chamadas), blocos de contas, servidores e canais (texto, voz, categorias, cargos, convites ativos e usos), mensagens (total, 24 h, 7 dias, servidores x DMs, anexos e tamanho) e conversas diretas (1:1 e grupos). **Não existem no Spook** e por isso não aparecem: usuários verificados e login social (não há verificação de e-mail nem OAuth), banimentos, amizades, pedidos e bloqueios. "Última atividade" de um usuário é o **último login** (sessão mais recente), porque o app não registra outra atividade.
- **Chamadas ao vivo (voz hexagonal).** `voice.Service.LiveRooms` usa a porta que já existia (`Provider.ListRooms`/`ListParticipants`, sem tocar no SDK) e devolve sala, participantes, câmera, tela e a entrada mais antiga; o `admin` define a sua interface (`CallSource`) e o pacote `app` adapta, então `admin` não importa `voice`. Voz desligada vira "indisponível" com o motivo; falha do LiveKit também, sem vazar o erro.
- **Prometheus do LiveKit.** O LiveKit 1.13 expõe métricas em `prometheus.port` (6789): foi habilitado em `deploy/livekit/livekit.yaml` e no template de produção, **sem publicar a porta** (só a rede interna do Compose; o túnel não a alcança). O backend lê `LIVEKIT_METRICS_URL` (padrão `http://<host de LIVEKIT_INTERNAL_URL>:6789/metrics`) com timeout de 3 s. Usa `livekit_room_total`, `livekit_participant_total`, `livekit_track_published_total`/`subscribed_total`, `livekit_packet_bytes`/`livekit_packet_total` por `direction`, `livekit_packet_loss_total` e as médias (soma/contagem) de `livekit_jitter_us`, `livekit_rtt_ms` e `livekit_quality_score`; o que o LiveKit ainda não expôs fica nulo ("—"), nunca zero. Taxas por segundo (bits, pacotes) são a diferença entre duas leituras (contador que reinicia vira 0). Verificado contra o LiveKit 1.13.11 de dev: o endpoint responde na rede do Compose, mas **sem tráfego de mídia** só aparecem os contadores de sala/participante/qualidade; os nomes dos demais vêm do código do LiveKit e devem ser conferidos numa chamada real (`VALIDACAO-MANUAL.md`).
- **Aplicação e armazenamento.** Versão (`SPOOK_VERSION`, em produção a imagem com o tag; senão "dev"), commit (`SPOOK_COMMIT` ou `vcs.revision` do build), ambiente, hora do servidor, uptime, Go, goroutines, heap, RSS (`/proc/self/status`; nulo fora do Linux), tamanho do banco e 6 maiores tabelas (`pg_total_relation_size`, linhas estimadas), pool do pgx (máximo, abertas, ociosas, em uso, esperas), fila do River (`river_job` por estado; indisponível se a tabela não existe) e gateway (conexões, sessões, usuários distintos, eventos entregues por segundo pela diferença do contador acumulado `Hub.Stats().Dispatched`). Armazenamento: anexos têm contagem e bytes (coluna `size_bytes`); avatares e ícones só contagem, porque o tamanho não é gravado (contar objetos no S3 por requisição seria varredura).

**Segurança do `/admin` e do Invisível (adicional).** Controle de acesso do admin: só `users.is_admin` define quem é admin (`ADMIN_USERNAMES` no boot, `spook admin grant|revoke|list` via `deploy/admin.sh` por SSH; nenhuma rota HTTP promove alguém); o `requireAdmin` consulta o banco a cada requisição, sem cache (401 sem sessão, 403 genérico para comum, rebaixar vale na hora); o "tempo real" é polling HTTP das mesmas rotas protegidas e nenhum dado de admin trafega pelo gateway; o guard do web é só conveniência. A cobertura é por construção: um teste enumera as operações `/api/admin/**` do OpenAPI e exige 401/403/2xx em todas, então rota nova sem guard falha. O `ci-entry.sh` do VPS não foi ampliado (continua com `receive-deploy`, `write-env` e `deploy`); `admin.sh` só roda por quem já tem shell (`gustavo` com `sudo`). Cloudflare Access em `/admin*` está documentada em `deploy/README.md` como camada extra opcional e **não foi configurada**. Invisível: três brechas do gateway foram corrigidas (RESUME após a presença expirar recriava o estado como "online"; corrida de PATCH entre o READY e o `Connect`; corrida do snapshot do READY, agora montado depois de assinar os tópicos, com falha fechada se `Self` falhar). Decisões: `TYPING_START` continua chegando (ação explícita na conversa) sem criar presença; participantes da voz continuam listados (estar em chamada é público); o contador `gateway.online_users` do admin inclui invisíveis (só número, só admin).
- **Instrumentação e vazamentos.** Cada requisição já é um span (`otelhttp`); o `admin` abre spans `admin.Overview`/`Live`/`System`/`Users`/`Servers`/`Calls`. A lista de usuários só devolve id, username, e-mail, contagens, último login e data de entrada: nunca hash de senha, token, chave de avatar ou sessão (teste de integração confere o corpo). Erros 5xx saem genéricos pelo hook global do projeto.
- **Web.** Rota `/admin` com layout próprio (barra lateral recolhível com Dashboard, Usuários, Servidores e Chamadas, "Voltar ao app", usuário/tema/sair; breadcrumb), componentes no estilo shadcn dos tokens do tema (claro/escuro pelo `ThemeProvider`), tabelas ordenáveis com `aria-sort`, busca com debounce de 300 ms e paginação, estados de carga/erro/vazio. Link "Painel de administração" na barra de servidores e no cabeçalho das páginas de configurações, só para admins. Sem dependência nova.
- **Testes.** Go: unitários do service (autorização, séries com dias vazios, comparação, cache/singleflight, filtro e resumo de chamadas, taxa de eventos, validação de ordenação) e do parser Prometheus; integração (401/403, rebaixar vale na hora, bootstrap idempotente, 14 dias e cache, usuários com busca/ordenação/paginação e sem dados sensíveis, servidores, chamadas com LiveKit falso, sistema). Web: Vitest + MSW (guarda, link, dashboard, polling com relógio falso, ordenação, busca, paginação, estados) e E2E `apps/web/e2e/admin.spec.ts` (precisa de `E2E_PROMOTE_CMD`, ver `apps/web/README.md`).

**Repaginação visual — Etapa 1 (auditoria e design system)** (fora das fases; web)
- **Tokens.** Neutros com tom roxo em camadas (`background` < `surface-1` < `surface-2` < `surface-3`), escala `brand-50…950` a partir da paleta do logo, semânticas (sucesso, aviso, perigo, info), cores de presença e `speaking`. Valores finais e contraste em 9.2; checagem automática em `scripts/contrast.mjs`. `--input` e `--ring` (claro) mudaram para passar 3:1; `--primary-foreground` passou de `#FAFAFA` para `#FFFFFF`; roxo em texto usa `--brand-text`.
- **CSS base.** Cursor, hover/active/foco/desativado e movimento reduzido ficam no CSS base (9.5). Os seletores usam `:is()` e não `:where()` porque o preflight do Tailwind tem `button { opacity: 1 }` (especificidade de tag) que anularia o `opacity` de desativado.
- **Componentes.** `ui/` ganhou `skeleton`, `separator`, `scroll-area`, `kbd`, `empty-state`, `spinner`, `badge` (com `CountBadge`), `slider`, `context-menu`, `avatar` (iniciais, anel de fala, status); `Button` ganhou `loading`, `soft` e tamanhos `xl`/`icon-sm`/`icon-lg`; `Dialog`, menus, tooltips e toasts ganharam animação. A API anterior continua válida. Novas dependências: `@radix-ui/react-context-menu`, `@radix-ui/react-scroll-area`, `@radix-ui/react-slider` (mesma família já usada; só entram no bundle se importadas).
- **Avatar.** O fallback padrão agora são as iniciais sobre gradiente derivado do id/username (sempre com texto branco AA); a mini logo (9.4) deixou de ser o avatar padrão e só aparece com `fallback="logo"`.
- **Página de referência.** `/dev/design-system` só existe com `import.meta.env.DEV` (rota lazy, ausente do build de produção).
- **Capturas.** `apps/web/design/` (Playwright próprio, fora do CI e do `pnpm e2e`): `capture.spec.ts` captura cada tela em claro/escuro e 1440×900/390×844 em `docs/design/${DESIGN_OUT}` (`antes` ou `depois`); `design-system.spec.ts` captura a página de referência. Medição de bundle: `scripts/bundle-size.sh`.
- **Chat e membros (repaginação).** Avatar sem imagem usa iniciais por padrão (ver 9.4). Nome de cargo usa cor ajustada por contraste (`lib/role-color.ts`, 4,7:1). Mensagens: barra de ações flutuante (hover/foco) e, sem hover, botão "⋯" sempre visível + toque longo; visualizador de imagens único por conversa; contador do composer só a partir de 1800 caracteres. Membros agrupados por cargo mais alto (só online), "Online" e "Offline", virtualizados acima de 150 linhas, e cartão de perfil (popover/bottom sheet) com os dados que a API já tem. Fora de escopo mantido: mensagem otimista na lista (o texto é mantido no campo se o envio falha), bio/pronomes/banner de imagem (não existem no backend).

**Repaginação visual — Configurações** (fora das fases; web)

- **Área em tela cheia.** `/settings/*` tem layout próprio (`features/settings/settings-layout.tsx`), sem a barra de servidores. Seções: `profile`, `notifications`, `voice`, `appearance` e, só no desktop (Tauri), `app`. `/settings` abre o perfil no desktop e é a lista de seções abaixo de 768 px (lista → detalhe com "voltar"). `/profile` redireciona para `/settings/profile`; `/settings/app` na web continua existindo e apenas explica, mas some da navegação.
- **Fechar.** O botão fechar e o Esc voltam para a última rota fora das configurações (guardada em `features/settings/return-path.ts`); sem rota anterior (link direto, recarga), vão para `/`. O Esc é ignorado se houver diálogo, menu ou lista aberta.
- **Voz e vídeo.** Reaproveita os controladores e preferências de `features/voice` (os mesmos do diálogo "Dispositivos" da chamada); a qualidade da tela e o áudio do compartilhamento gravam os mesmos valores iniciais que o diálogo de compartilhar usa. Não há opção de PiP para configurar (ele é acionado no vídeo).
- **Aparência.** Tema claro/escuro/sistema via `ThemeProvider` (a prévia usa os valores literais dos tokens, porque as variáveis do documento seguem o tema ativo). Movimento reduzido segue o sistema; a tela só informa o estado.
- **Perfil.** Nome de exibição e avatar como antes; usuário e e-mail aparecem só para leitura (não são editáveis). "Sair" fica no rodapé da navegação das configurações.

**Repaginação visual — Palco de voz** (fora das fases; web)
- **Palco** (`features/voice/stage/`): grade de tiles 16:9 com avatar grande sobre a cor dominante do avatar (canvas 8x8; sem imagem ou sem CORS cai na cor derivada do id), anel verde em quem fala, modo foco (tile grande + tira) e barra flutuante (microfone `M`, câmera `V`, tela, dispositivos, sair) que some após 3 s sem movimento. O botão "Sair do canal" saiu do cabeçalho; o cartão da barra lateral continua com "Sair da chamada".
- **Decisões.** Câmera ligada ocupa o tile da pessoa; a tela é um tile à parte ("Tela de X"). O payload de voice state não traz "mutado pelo servidor": o ícone só aparece para quem não tem permissão de falar no meu próprio tile. Não há seleção de quem assistir (a engine assina todas as faixas); "Destacar" ocupa esse lugar. O tile de convite só existe em servidor com uma pessoa na chamada e reaproveita o diálogo de convites das configurações do servidor (permissão `CREATE_INVITE`); em DM foi omitido. `store.mediaIssue` guarda o último erro de microfone/câmera/tela para a faixa de aviso do palco, e `useVoiceAvailabilityStore` guarda o 503 do token (voz desligada) para o estado vazio do canal.

**Repaginação visual — Diálogos, DMs, estados e admin** (fora das fases; web)
- **Diálogos.** `DialogContent flush` + `DialogHead` (ícone, título, descrição) + `DialogBody` (rolagem com `ScrollArea`) + `DialogActions` (rodapé fixo; ação destrutiva em `start`). Configurações do servidor tem título por aba ("Configurações do servidor", "Cargos e permissões", "Convidar pessoas") e pergunta antes de descartar alterações (nome, cargo). Cargos: dois painéis no desktop, lista → detalhe com "Todos os cargos" abaixo de 768 px; permissões agrupadas em Geral, Texto, Voz e Moderação (mesmas flags; só os textos de anexos/voz deixaram de dizer "fase futura"); cor por amostras nomeadas, cor personalizada e "Sem cor". Convites: cartão (código, link, usos, validade), "Copiado" por 2 s, revogar com confirmação.
- **DMs.** A API não devolve texto da última mensagem, só `last_message_id`: a lista mostra a hora derivada do Snowflake (`lib/snowflake-time.ts`, época 2026-01-01) e não inventa prévia de texto. Busca local pelo título; estado vazio com ilustração e ação.
- **Estados.** `StateScreen` (dentro do app), `StatePage` (página inteira) e `ErrorState` (403 = "Sem permissão"; rede/5xx = "Tentar de novo"). "Já é membro" é detectado no cliente (`guild_id` da prévia do convite está em `GET /guilds`). `ErrorBoundary` global e `errorComponent` da raiz do roteador mostram `CrashScreen` sem stack (detalhes só no console).
- **Admin.** Mesmos tokens e superfícies; `StatCard` com ícone e esqueleto, tabelas com cabeçalho fixo e sombras de rolagem horizontal (`scroll-shadow-x`), `TableSkeleton`/`TableEmpty`, "Tentar de novo" no erro. Gráficos só harmonizados (cores de marca, linhas de grade); métricas e endpoints intactos.

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
| status_pref | text | `online` (padrão), `dnd` ou `invisible` (migration 00008, adicional) |
| custom_status_text, custom_status_emoji | text NULL | status personalizado (até 128 e 32 caracteres) |
| custom_status_expires_at | timestamptz NULL | vencido = sem status (avaliado no servidor) |
| is_admin | boolean | `false` (padrão); `true` libera `/api/admin/**` e o painel `/admin` (migration 00009, adicional; promovido por `ADMIN_USERNAMES`) |
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
| mention_ids | bigint[] | usuários mencionados com @username, resolvidos no envio (Fase 6b); default `{}` |
| reference_id | bigint NULL | mensagem respondida (adicional responder); sem FK, validada no envio |
| pinned_at | timestamptz NULL | quando foi fixada (adicional fixar); NULL = não fixada |
| pinned_by | bigint NULL | quem fixou |

Índice principal: `(channel_id, id DESC)`. Índice parcial `(channel_id, pinned_at DESC) WHERE pinned_at IS NOT NULL` para as fixadas.

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

### notification_settings (adicional)
| Coluna | Tipo | Notas |
| --- | --- | --- |
| user_id | bigint FK users | PK composta |
| scope | text | `guild` ou `channel` (canal de servidor, DM ou DM em grupo); PK composta |
| target_id | bigint | servidor ou canal, sem FK; PK composta |
| muted | boolean | silenciado; sem `muted_until` = até reativar |
| muted_until | timestamptz NULL | fim do silêncio (vencido não vale, sem job) |
| level | text NULL | `all`, `mentions`, `none`; nulo herda (canal -> servidor -> padrão) |
| updated_at | timestamptz | |

### Mapa de migrations

Todas aditivas (`server/db/migrations`; o rollback de imagem não desfaz migrations).

| Migration | Conteúdo |
| --- | --- |
| 00001 a 00006 | usuários, sessões, servidores/canais/mensagens, DMs, anexos, notificações (fases 1 a 6) |
| 00007_reply_pins | `messages.reference_id`, `pinned_at`, `pinned_by` e índice parcial das fixadas (adicional) |
| 00008_status_notifications | `users.status_pref`, `custom_status_*` e a tabela `notification_settings` (adicional) |
| 00009_admin | `users.is_admin` e índice `messages (author_id)` (adicional) |

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
- Adicional: a pessoa pode escolher Não perturbar (aparece `dnd`) ou Invisível (aparece offline para os outros, com a conexão e a voz intactas) e definir um status personalizado com expiração (ver o bloco "Adicional: status..." em 5.5).

### 7.7 Voz
- Um usuário está em no máximo um canal de voz por vez; entrar em outro sai do anterior.
- Tokens do LiveKit valem 10 minutos e só para a sala do canal.
- Entrar exige CONNECT; falar exige SPEAK; câmera e tela exigem VIDEO.

### 7.8 Notificações
- Não lidas = mensagens com ID maior que `last_read_message_id`.
- Web push só é enviado se o usuário não tiver sessão de gateway ativa.
- Push apenas para DMs e menções diretas.
- Adicional: silenciar (15 min, 1 h, 8 h, 24 h ou até reativar) e nível (tudo, só menções, nada) por servidor, canal ou DM suprimem push, toast e notificação nativa, mas não a contagem de não lidas; Não perturbar suprime os avisos e o push. Detalhes em 5.5.

### 7.9 Adicionais: limites, permissões e visibilidade

**Limites**

| Regra | Valor | Fonte |
| --- | --- | --- |
| Mensagens fixadas por canal | 50 (a 51ª dá 409; fixar uma já fixada com o canal cheio continua 204) | `message.MaxPins` |
| Prévia da mensagem respondida | 100 runes, vazia se a original foi apagada | `message.ReplyPreviewRunes` |
| Mencionados por mensagem (inclui o respondido, que tem prioridade) | 20 | `maxMentionIDs`, `notification.MaxMentions` |
| Status personalizado | texto até 128 e emoji até 32 runes; expiração futura de até 48 h | `presence.MaxCustom*` |
| Nível padrão sem configuração | servidor: só menções; DM e DM em grupo: tudo | `notification` (SPEC 5.5) |
| Silêncios oferecidos | 15 min, 1 h, 8 h, 24 h ou até reativar (`muted_until` ausente) | cliente + `PUT notification-settings` |
| Admin: página das listas | 25 itens | 5.5 (admin) |

**Permissões e erros**
- Responder: quem pode enviar no canal (mesmas regras de 7.3, inclusive o rate limit de 5 mensagens a cada 5 s). Original inválida: 422.
- Fixar e desafixar: `MANAGE_MESSAGES` em canal de servidor (403 sem ela; 404 sem acesso ao canal); em DM, qualquer participante. Mensagem apagada ou de outro canal: 404. Mais de 50: 409. Listar as fixadas: basta ver o canal.
- Editar com ↑ segue a regra de 7.3: só o autor edita.
- Silenciar, definir nível e status: sempre o próprio usuário, sobre si mesmo (rotas `@me`); não existe configuração de terceiros. `scope=guild` exige ser membro (404); `scope=channel` usa a autorização do canal ou DM (404/403). `muted_until` no passado ou sem `muted=true`, ou status com expiração no passado/acima de 48 h, ou preferência inválida: 422. `DELETE` de configuração é idempotente (204) e não exige acesso ao alvo.
- Admin: 401 sem sessão e 403 com sessão de conta comum em toda `/api/admin/**`; ordenação fora da lista fixa: 422. O painel é somente leitura (só `GET`): administrador não ganha poder sobre mensagens, canais ou usuários por ser admin. A checagem lê `users.is_admin` do banco a cada requisição (rebaixar vale na hora).
- 429: o limite geral da API (30 req/s por IP, rajada de 90) e o de mensagens valem para todas as rotas acima; não há limite próprio para fixar, presença ou admin.

**Visibilidade e expiração**
- Invisível: terceiros veem `offline`, sem status personalizado e sem entrar no snapshot do `READY`; a conexão, a voz e o recebimento continuam normais. Como o push depende de "não ter sessão de gateway ativa", invisível com a aba aberta não recebe push e, sem sessão, recebe como qualquer usuário.
- Não perturbar vale também ausente e suprime push, toast e notificação nativa; as contagens de não lidas e de menções continuam.
- Apagar uma mensagem fixada a desafixa; editar a original não republica as respostas (o cliente atualiza a citação).
- Silêncio vencido deixa de valer sem job (comparado com `now` na leitura e no envio do push); status personalizado vencido é tratado como inexistente na leitura, e um temporizador por usuário conectado avisa a expiração em tempo real.
- Nível `all` em servidor vale para toast e notificação nativa, mas não amplia o push (continua só DMs e menções diretas).
- Cache do admin: visão geral e contagens 30 s, ao vivo/chamadas/sistema 5 s, tamanho do banco 60 s; chamadas simultâneas se juntam (singleflight); listas sem cache. Séries em dias UTC.
- Desktop: "Fechar vai para a bandeja" padrão ligado; iniciar com o sistema e minimizado padrão desligados; "minimizado" só vale em aberturas automáticas.

- **Invisível (testado por todos os caminhos):** nenhum `PRESENCE_UPDATE`, `READY` de terceiros, payload REST (membros, servidores, DMs, mensagens, convites) nem rota do admin revela presença ou status de quem está Invisível; digitar e estar na voz seguem visíveis por serem ações explícitas; o push segue a regra da conexão real (sessão aberta: aviso in-app sem push; sem sessão: push), e escolher Não perturbar substitui o Invisível (o status é um valor só) e suprime o push.
- **Acesso ao admin:** 401 sem sessão, 403 para conta comum, checagem no banco a cada requisição, sem eventos de admin no gateway.

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
- [x] Status muda em tempo real para os demais usuários.
- [x] "Digitando…" aparece e expira corretamente.
- [x] DMs 1:1 e em grupo funcionam com as regras da seção 7.4.

### Fase 5 — Voz, vídeo e tela (web)
- [x] Dois usuários conversam por voz num canal; um compartilha a tela e o outro vê. (E2E local com mídia real contra o LiveKit; a validação em produção, pela rede pública, está em `VALIDACAO-MANUAL.md`.)
- [x] A lista de participantes do canal de voz atualiza em tempo real para todo o servidor.
- [x] Permissões CONNECT, SPEAK e VIDEO são respeitadas.

### Fase 6 — Uploads e notificações
- [x] Upload de imagem gera thumbnail e aparece na mensagem.
- [x] Arquivos acima do limite ou de tipo inválido são rejeitados.
- [x] Contagem de não lidas é correta após ler e ao receber novas mensagens.
- [x] Web push chega quando o usuário está offline. (Envio verificado em integração contra um serviço de push de teste, com VAPID e cifra; o recebimento real em navegador/dispositivo está em `VALIDACAO-MANUAL.md`.)

### Fase 7 — Desktop
Entregue: casca Tauri 2 com login no chaveiro do SO, gateway por ticket, CORS e notificações nativas (7a); voz, câmera e tela nativas em Rust com o LiveKit SDK, sem WebRTC do WebView (7b); workflow **Desktop** que gera os instaladores nos 3 SOs (Windows x64, macOS arm64 e x64, Linux x64), verde no GitHub Actions. O que falta é **validação manual** em máquinas reais (`VALIDACAO-MANUAL.md`, Fase 7), por isso os critérios abaixo seguem abertos.

- [ ] O app Tauri roda no Windows, macOS e Linux com todas as funcionalidades da web. (Instaladores compilam nos 3 SOs; instalação e uso real aguardam validação manual.)
- [ ] Voz e compartilhamento de tela funcionam no Linux e no macOS via captura nativa. (Núcleo Rust verificado contra o LiveKit com mídia sintética no Linux; captura real de microfone, câmera e tela aguarda validação manual.)
- [ ] Versão liberada para usuários e canal de feedback definido. (Ação do dono: tag `desktop-v<versão>` gera o release rascunho; o canal de feedback é a questão em aberto 4.)

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

### Adicionais (fora das fases)
Cada item abaixo é aceito pelos critérios do RF correspondente (seção 3) e pelas regras de 7.9. Os testes automáticos estão nos blocos "Adicional: ..." da 5.5; o que depende de ouvido, hardware, SO ou produção está em `VALIDACAO-MANUAL.md` ("Adicionais").

- [x] Responder com citação, `mention_reply` e ↑ para editar (RF13).
- [x] Fixar e desafixar mensagens, limite de 50 e painel (RF14).
- [x] Não perturbar, Invisível e status personalizado com expiração (RF15).
- [x] Silenciar e níveis de notificação com herança, sem perder a contagem de não lidas (RF16).
- [ ] Qualidade da voz nos três níveis de ruído, porta, teste de microfone e volume (inclusive 200% no desktop) em máquinas reais (RF17; lógica coberta por testes, áudio real só manual).
- [ ] Qualidade da tela e Picture-in-Picture em navegador e SO reais (RF18).
- [x] Controles de voz no painel do usuário (RF19; aparência na validação manual).
- [ ] Bandeja, início com o sistema, contador no ícone e clique na notificação nos três SOs (RF20).
- [x] Painel `/admin` e `spook admin` verificados por testes; [ ] conferência dos números e da mídia do LiveKit contra a produção (RF21).

---

## 9. Identidade visual

Fonte: a ficha `packages/brand/Spook-identidade-visual.pdf` e os arquivos em `packages/brand/assets/`. Em caso de divergência, o PDF prevalece.

### 9.1 Nome e textos
- **Spook** no texto corrido; **SPOOK** (maiúsculas) apenas no logo.
- Mascote: fantasma de neon roxo com headset ("spook" = fantasma em inglês).
- Frases da tela de entrada: "Seus servidores, sua galera, num só lugar." e "Chat · Voz · Vídeo · Compartilhar tela". Não há slogan separado.
- Instalador do desktop: `Spook-<versão>-<so>-<arquitetura>` (ex.: `Spook-0.1.0-windows-x64.exe`).

### 9.2 Cores e tokens (design system)

Roxo como cor principal, igual nos dois temas, sobre neutros com leve tom roxo (matiz ~270°, saturação baixa) em **camadas de superfície**. Os valores são variáveis CSS em `packages/brand/src/tokens.css` (cores, sombras, z-index, durações) e `apps/web/src/styles.css` (raios, curvas, escala tipográfica, animações e CSS base), expostos como utilitários do Tailwind; os nomes semânticos do shadcn continuam valendo. A referência viva dos componentes é a rota `/dev/design-system` (só em desenvolvimento) e `docs/design/DESIGN-SYSTEM.md`. Não existe tom do Tailwind igual a `#7C5CC4`, então a cor entra como personalizada. A ficha `Spook-identidade-visual.pdf` não está no repositório: valem a paleta do logo (abaixo) e este registro; se a ficha divergir, ela prevalece.

**Cores base (nomes do shadcn + camadas)**

| Variável | Uso | Claro | Escuro |
| --- | --- | --- | --- |
| `--primary` | Marca: botões, destaques | `#7C5CC4` | `#7C5CC4` |
| `--primary-foreground` | Texto sobre a marca | `#FFFFFF` | `#FFFFFF` |
| `--brand-text` | Roxo para **texto** (links, ênfase) | `#5E44A8` | `#B7A2F0` |
| `--background` | Fundo da tela | `#FBFAFE` | `#0A0912` |
| `--surface-1` / `--sidebar` | Painéis, barras laterais | `#F4F1FA` | `#100E1A` |
| `--surface-2` / `--card` / `--popover` | Cartões, diálogos, menus | `#FFFFFF` | `#161325` |
| `--surface-3` / `--secondary` | Elevado, botão secundário, hover forte | `#ECE7F7` | `#1F1B33` |
| `--muted` | Áreas suaves | `#EFEBF8` | `#1A1730` |
| `--accent` | Hover/seleção suave (tom roxo) | `#EFE9FB` | `#241F3D` |
| `--overlay` | Fundo atrás de diálogos | `rgb(23 19 42 / .55)` | `rgb(5 4 12 / .72)` |
| `--foreground` | Texto principal | `#17132A` | `#F4F2FA` |
| `--muted-foreground` | Texto secundário | `#5B5473` | `#A59FBD` |
| `--border` | Bordas e divisores | `#E2DCF0` | `#2A2540` |
| `--input` | Borda de campos (3:1) | `#7F779D` | `#6F6890` |
| `--field` | Fundo de campos | `#FFFFFF` | `#110F1E` |
| `--ring` | Anel de foco | `#6B4BB5` | `#A58BE6` |
| `--destructive` | Fundo de ação destrutiva | `#9F0712` | `#9F0712` |
| `--destructive-text` | Texto de erro | `#9F0712` | `#FF6467` |

**Escala da marca** (`brand-50` … `950`): `#F5F2FF`, `#EEE8FF`, `#CDBEF5`, `#B7A2F0`, `#A58BE6`, `#7C5CC4`, `#6B4EB5`, `#5E44A8`, `#3B2A6B`, `#261B47`, `#16112A`. Os degraus 100, 200, 400, 500, 700, 800 e 950 são as cores do logo.

**Semânticas** (cada uma tem sólido + texto sobre o sólido, texto sobre superfície e fundo suave `-soft`):

| Token | Sólido claro / escuro | Texto claro / escuro | Fundo suave claro / escuro |
| --- | --- | --- | --- |
| `success` | `#157A38` / `#2FBF71` | `#126B36` / `#4CC77E` | `#E3F4EA` / `#11291C` |
| `warning` | `#F2B63D` / `#F2B63D` | `#8A5A00` / `#F2B63D` | `#FDF1D6` / `#2E2410` |
| `info` | `#1D5FB8` / `#4D8FE8` | `#1D5FB8` / `#6FA8F5` | `#E1ECFB` / `#14233D` |
| `danger` (`destructive`) | `#9F0712` / `#9F0712` | `#9F0712` / `#FF6467` | `#FBE4E6` / `#34141A` |

**Presença e voz:** `online` `#188A3F` / `#3DDC84`; `idle` `#AD6F00` / `#F2B63D`; `dnd` `#D13438` / `#FF6B6B`; `invisible` e `offline` `#7A7490` / `#8A849F`; `speaking` (anel de quem fala) `#188A3F` / `#3DDC84`.

**Contraste calculado (WCAG 2.x)**: `node scripts/contrast.mjs` lê `tokens.css`, calcula cada par nos dois temas e falha se algum ficar abaixo do mínimo (texto 4.5:1; borda de campo, anel de foco e bolinhas 3:1). Pior caso de cada par sobre as quatro superfícies:

| Par | Token | Claro | Escuro | Pior contraste (claro) | Pior contraste (escuro) | Mínimo |
| --- | --- | --- | --- | --- | --- | --- |
| texto principal | `--foreground` | `#17132a` | `#f4f2fa` | 14.9 | 15.0 | 4.5:1 |
| texto secundário | `--muted-foreground` | `#5b5473` | `#a59fbd` | 5.9 | 6.2 | 4.5:1 |
| roxo em texto (links) | `--brand-text` | `#5e44a8` | `#b7a2f0` | 6.0 | 7.1 | 4.5:1 |
| texto sobre o roxo da marca | `--primary-foreground` | `#ffffff` | `#ffffff` | 5.0 | 5.0 | 4.5:1 |
| texto de erro | `--destructive-text` | `#9f0712` | `#ff6467` | 6.9 | 5.8 | 4.5:1 |
| texto sobre botão destrutivo | `--destructive-foreground` | `#ffffff` | `#ffffff` | 8.4 | 8.4 | 4.5:1 |
| texto de sucesso | `--success-text` | `#126b36` | `#4cc77e` | 5.4 | 7.2 | 4.5:1 |
| texto sobre sucesso sólido | `--success-foreground` | `#ffffff` | `#04210f` | 5.4 | 7.2 | 4.5:1 |
| texto de aviso | `--warning-text` | `#8a5a00` | `#f2b63d` | 4.9 | 8.4 | 4.5:1 |
| texto sobre aviso sólido | `--warning-foreground` | `#2a1b00` | `#2a1b00` | 9.2 | 9.2 | 4.5:1 |
| texto de info | `--info-text` | `#1d5fb8` | `#6fa8f5` | 5.1 | 6.4 | 4.5:1 |
| texto sobre info sólido | `--info-foreground` | `#ffffff` | `#04122b` | 6.2 | 5.7 | 4.5:1 |
| borda de campo (UI 3:1) | `--input` | `#7f779d` | `#6f6890` | 4.0 | 3.5 | 3:1 |
| anel de foco (UI 3:1) | `--ring` | `#6b4bb5` | `#a58be6` | 5.3 | 5.9 | 3:1 |
| anel de quem fala (UI 3:1) | `--speaking` | `#188a3f` | `#3ddc84` | 3.7 | 9.3 | 3:1 |
| status online | `--online` | `#188a3f` | `#3ddc84` | 3.7 | 9.3 | 3:1 |
| status ausente | `--idle` | `#ad6f00` | `#f2b63d` | 3.4 | 9.1 | 3:1 |
| status não perturbar | `--dnd` | `#d13438` | `#ff6b6b` | 4.1 | 6.0 | 3:1 |
| status invisível/offline | `--invisible` | `#7a7490` | `#8a849f` | 3.7 | 4.7 | 3:1 |

- O erro continua vermelho de propósito: um botão de excluir roxo pareceria um botão comum. O `#7C5CC4` puro como texto não alcança AA sobre todas as superfícies (4.0:1 no escuro); por isso existe `--brand-text`. Texto sobre o roxo da marca é branco (5.0:1).
- Divergências da versão anterior da tabela, por contraste: `--input` (antes `#E1E1E1`, 1.3:1) e `--ring` no claro (antes `#A58BE6`, 2.8:1) agora passam de 3:1.
- Tema inicial: o do sistema operacional; o usuário pode trocar e a escolha fica salva.

**Raios:** `xs` 4 px, `sm` 6, `md` 8 (controles), `lg` 12 (menus, toasts), `xl` 16 (cartões, diálogos), `2xl` 20, `full`.

**Sombras:** `xs`, `sm`, `md`, `lg`, `xl` (tinta roxa no claro; no escuro, mais densas e com filete de luz de 1 px) e `glow`, o brilho neon do mascote, reservado a realces (hover do botão primário no escuro, destaque). `speaking` é o anel verde de fala com brilho.

**Tipografia (escala):** `2xs` 11/16, `xs` 12/16, `sm` 14/22 (corpo da interface), `base` 16/24 (leitura longa), `lg` 18/26, `xl` 20/28, `2xl` 24/32, `3xl` 30/36, `4xl` 38/44; títulos com `tracking` -0.015em (`-0.03em` no display) e `text-wrap: balance`. Números tabulares em horários, contadores e tabelas.

**Movimento:** curvas `standard` (.2,0,0,1), `out` (.16,1,.3,1; entradas), `in` (.4,0,1,1; saídas) e `spring` (.34,1.56,.64,1). Durações `instant` 80 ms, `fast` 120, `base` 180, `slow` 260, `slower` 400. Só `transform` e `opacity`; com `prefers-reduced-motion` tudo é instantâneo (exceto o spinner).

**z-index:** sticky 10, dropdown 40, overlay 50, modal 60, popover 70, toast 80, tooltip 90.

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
| Mini logo (ícone de servidor, perfil) | `mini-logo.svg` / `.png` | Placeholder de ícone de servidor. Deixou de ser o avatar padrão: quem não tem imagem mostra iniciais sobre cor derivada do id (`fallback="initials"`) |
| Aba do navegador | `favicon.ico`, `favicon.png` | `apps/web/public/` |
| iPhone e iPad | `apple-touch-icon.png` (180 px, fundo `#0A0A0A`) | `apps/web/public/` |
| PWA / app instalável | `icon-192.png`, `icon-512.png`, `icon-maskable.png` | `apps/web/public/` + `manifest.webmanifest` |
| Prévia de link | `og-image.png` (1200 × 630) | `apps/web/public/` + meta tags Open Graph |
| Desktop (Windows, macOS, Linux) | `icon.png` (1024 × 1024) | Gerar com `pnpm tauri icon` em `apps/desktop/src-tauri/icons/` |
| E-mails (futuro) | `mail/logo.png`, `mail/lettering.png` | Reservados; envio de e-mail não está no escopo atual |

- O neon dos SVGs usa filtro de brilho (`feGaussianBlur`). Onde o filtro pesar ou não renderizar (listas longas, ícones pequenos), usar o PNG ou a mini logo.
- Cores de e-mail (fundo `#050505`, cartão `#111111`, botão `#7C5CC4`, confirmação `#16A34A`) ficam registradas para quando houver envio de e-mail.

### 9.5 Regras de interface (valem para toda tela)

- **Tudo que é clicável tem `cursor: pointer` e estados**: hover, active (pressionado), `:focus-visible` (anel de 2 px com offset, cor `--ring`) e disabled (`cursor: not-allowed` e opacidade .5, sem `pointer-events: none`). Isso mora no **CSS base** (`apps/web/src/styles.css`, camada `base`): botões, links, `[role=button|tab|menuitem*|option|switch|checkbox|radio|link|slider]`, `summary`, `select`, `label` de checkbox/radio/switch, e `[data-clickable]`. Componente ou tela nova não repete isso; use `<button>`/`<a href>` ou dê o `role` correto.
- Nada de cor, raio, sombra, duração ou z-index fora dos tokens (9.2).
- Contraste AA nos dois temas, conferido por `scripts/contrast.mjs`; estado nunca só por cor.
- Animações só com `transform` e `opacity`, respeitando `prefers-reduced-motion`.
- Componentes base em `apps/web/src/components/ui/` (documentados em `docs/design/DESIGN-SYSTEM.md`); ilustrações do mascote em `components/illustrations/` (SVG próprio, cores por tokens, `aria-hidden`).

### 9.6 Repaginação visual: o que foi entregue e o que ficou pendente

Registro da repaginação (antes/depois lado a lado em `docs/design/README.md`; problemas de partida em `docs/design/AUDITORIA.md`; componentes em `docs/design/DESIGN-SYSTEM.md`). Tokens conferidos contra `packages/brand/src/tokens.css` e `apps/web/src/styles.css` (cores claro/escuro, raios, sombras, tipografia, curvas, durações, z-index) e `node scripts/contrast.mjs` passa.

- **Design system:** tokens, CSS base (cursor, hover, active, foco, disabled), componentes de `components/ui/`, ilustrações do mascote, referência viva em `/dev/design-system`.
- **Telas e componentes repaginados:** login, cadastro e convite; 404 e telas de erro/estado; barra de servidores, lista de canais, rodapé de usuário/voz e shell responsivo com gaveta (390 px); chat (mensagens, ações flutuantes por hover e toque, citação, fixadas, visualizador de imagem, composer com anexos, estados vazios, avatar com iniciais); lista de membros agrupada e cartão de perfil (gaveta no celular); configurações em tela cheia (perfil, notificações, voz e vídeo, aparência, aplicativo); palco de voz (grade de tiles, tela em foco, barra flutuante, tile de convite, diálogo de dispositivos); diálogos (criar servidor/canal, convite, cargos e permissões, configurações do servidor, adicionar servidor, novo grupo, participantes); DMs; painel `/admin`.
- **Verificação:** capturas completas em `docs/design/depois/` (2 temas x 1440 e 390); `apps/web/design/a11y-check.spec.ts` (foco visível, cursor, movimento reduzido; resultado em `docs/design/a11y-check.txt`); bundle em `docs/design/bundle-depois.txt`.
- **Pendências:** convite deslogado sem o nome do servidor; sem prévia de texto nas DMs; gráficos do `/admin` não reescritos; `ErrorBoundary` sem captura; nome de exibição truncado no rodapé do usuário (240 px com quatro botões); `index` do web acima de 500 kB (dividir por rota); validação em Safari/Firefox e no Tauri (`VALIDACAO-MANUAL.md`).

---

## 10. Questões em aberto

1. **Metas de performance da seção 4:** confirmar ou ajustar após o baseline do Laravel.
2. **Limites de negócio** (100 servidores por usuário, 25 MB por anexo, 10 pessoas por DM em grupo): valores iniciais, a validar.
3. **Backup do Postgres e do Garage** no VPS: estratégia e frequência.
4. **Canal de coleta de feedback** dos usuários após a fase 7.
5. **Disponibilidade do nome Spook:** registro de marca no INPI e nas lojas de aplicativos (pendência da ficha de identidade).
6. **Revisão do vetor final por um designer:** alguns programas de design não importam o filtro de neon do SVG.
