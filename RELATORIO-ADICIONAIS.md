# Relatório dos adicionais (fora do SPEC)

Tudo aqui foi pedido **depois** do checkpoint `checkpoint-spec-completo` (commit `e39b794`, 31/10/2026). A lista bruta sai de
`git log checkpoint-spec-completo..HEAD`. Este arquivo é atualizado a cada adicional e vira o relatório final.

## Resumo executivo (01/11/2026)

Desde o checkpoint foram entregues **9 commits em `main`** (267 arquivos, +26,8 mil / −0,6 mil linhas), todos com CI, Deploy e
Desktop (Windows, macOS arm64/x64, Linux) verdes e em produção. Os pedidos eram de qualidade de vida e nenhum estava no SPEC.

| # | Adicional | Commit | Onde |
| --- | --- | --- | --- |
| 1 | Supressão de ruído em 3 níveis (Forte = RNNoise grátis), eco e ganho, áudio da tela sem eco | `cbc3db1` (web), `915a713` (desktop) | Web + desktop |
| 2 | Volume por pessoa (web até 100%, desktop até 200%), áudio da tela com volume próprio | `fb060e8`, `6431522` | Web + desktop |
| 3 | Teste de microfone com medidor de nível e porta de ruído (sensibilidade) | `fb060e8`, `6431522` | Web + desktop |
| 4 | Não perturbar, Invisível e status personalizado (texto, emoji, expiração) | `9518246` | Backend + web |
| 5 | Silenciar servidor/canal/DM (15 min a "até reativar") e nível tudo/menções/nada | `9518246` | Backend + web |
| 8 | Responder com citação, editar a última com ↑, fixar mensagens | `44a834d` | Backend + web |
| 9 | Qualidade do compartilhamento de tela (presets, resolução, fps, prioridade) e Picture-in-Picture (só web) | `fb060e8`, `6431522` | Web + desktop |
| 10 | Desktop: bandeja, iniciar com o sistema, contador no ícone, clique na notificação abre o canal | `6431522` | Desktop |
| A | Controles de voz acima do perfil do usuário (canto inferior esquerdo) | `80cbda9` | Web |
| B | Painel administrativo `/admin` em tempo real | `48a7fa2` | Backend + web + deploy |
| C | Comando `spook admin grant|revoke|list` e `deploy/admin.sh` (gerir admins por SSH) | `cb7ec7f` | Backend + deploy |

(A numeração 1 a 10 segue a lista de funcionalidades que o dono escolheu; 1, 6 e 7 — push-to-talk, Ctrl+K e rascunho por canal — ficaram de fora por decisão dele.)

**Infra e migrations novas:** `00007_reply_pins`, `00008_status_notifications`, `00009_admin` (todas aditivas); Prometheus do LiveKit habilitado
só na rede interna; variável `ADMIN_USERNAMES` (opcional agora, pois existe o `spook admin`); novas dependências Rust (`nnnoiseless`,
`tauri-plugin-autostart`, feature `tray-icon`) e `@sapphi-red/web-noise-suppressor` no web.

**Decisões que merecem seu olho:** DeepFilterNet3 descartado (pacote depende de CDN de terceiros); expiração do status sem job (avaliada na
leitura + temporizador por usuário conectado); `@everyone`/`@here` não existem no Spook (a regra de menção direta já cobre o silêncio);
"Tudo" em servidor não amplia o push (só DMs e menções); heurística de 10 s para "clicar na notificação" no desktop (limitação do plugin);
admin por polling (não SSE), com cache de 5/30/60 s; ninguém é promovido automaticamente ao se cadastrar com um username "reservado".

**Limitações conhecidas:** PiP indisponível no desktop; contador do ícone no Linux só aparece no título da janela; ícone da bandeja no GNOME
exige a extensão AppIndicator; alt-tab dentro de 10 s após uma notificação também navega; ordenar usuários por mensagens no admin varre todos os
usuários (~375 ms com 10 mil); métricas de mídia do admin (perda, jitter, RTT) dependem de tráfego real do LiveKit.

**O que só o dono consegue validar** (roteiros em `VALIDACAO-MANUAL.md`, seção "Adicionais"): qualidade percebida da voz nos três níveis de ruído e
o CPU em notebook comum; áudio real, ganho de 200%, porta e teste de microfone no desktop; bandeja, autostart, badge e clique na notificação
nos três SOs; push real respeitando Não perturbar e silêncio com o app fechado; aparência de tudo nos dois temas e em tela estreita; números e
métricas de mídia do `/admin` contra a produção.

**Não feito (opcional):** cenário k6 do admin; SSE para o "ao vivo" do admin.

**Próximo passo planejado:** `PLANO-ADICIONAIS-2.md` documenta, em ondas, as funcionalidades do Antrax que o dono escolheu trazer para o Spook
(contas, social, servidores, mensagens, voz, perfil, desktop e gráficos do admin), com as decisões que dependem dele antes de começar.

## 1. Supressão de ruído e cancelamento de eco melhores (qualidade de vida)

**Pedido:** "ligar, desligar ou melhorar a supressão de ruído, como o Krisp do Discord, com a melhor alternativa gratuita; cancelamento de
eco para não ouvir a própria voz, ao mostrar a tela ou vazando na call".

**Pesquisa:** o Krisp do LiveKit só existe no LiveKit Cloud pago. As alternativas livres são o RNNoise (BSD-3) e o DeepFilterNet3 (MIT/Apache-2.0).

| Parte | Estado |
| --- | --- |
| Web: 3 níveis de ruído (Desligada, Padrão do navegador, Forte com RNNoise), eco e ganho com interruptores, diálogo de compartilhar tela | Feito |
| Web: DeepFilterNet3 em vez de RNNoise | Não usado: o pacote comunitário depende de CDN de terceiros (403) e não traz WASM/modelo; custo de CPU maior |
| Desktop: nível Forte (RNNoise nativo) e atraso do eco medido em vez de fixo | Feito |

**Ressalvas:** a qualidade percebida da voz humana nos três níveis, o CPU em notebook comum e o comportamento real do Chrome com as opções de
compartilhamento só podem ser julgados por você (`VALIDACAO-MANUAL.md`, seção "Adicionais").

## Volume por pessoa, teste de microfone e qualidade da tela (qualidade de vida, web)

**Pedido:** "volume por pessoa" (voz e áudio da tela, silenciar só para mim), "teste de microfone com medidor de nível e sensibilidade de entrada
(porta de ruído)" e "qualidade do compartilhamento de tela e vídeo em janela flutuante (Picture-in-Picture)".

| Parte | Estado |
| --- | --- |
| Volume por pessoa (voz, áudio da tela, silenciar só para mim, persistido, reaplicado ao republicar), máximo de 100% | Feito (web) |
| Volume até 200% | Não feito na web: exigiria WebAudio e arriscaria o cancelamento de eco; o contrato aceita `max > 1` para o desktop |
| Medidor de nível, "Testar" (grava 5 s e toca de volta) | Feito (web) |
| Sensibilidade de entrada: porta de ruído automática/manual com lookahead, hold e release, composta com o RNNoise num único grafo | Feito (web), com testes de DSP reais |
| Qualidade da tela: 4 presets, avançado, estimativa de banda e aviso de custo, persistida | Feito (web) |
| Picture-in-Picture nos tiles de vídeo | Feito (web) |
| Desktop (Rust): volume por pessoa, medidor, teste, porta, qualidade da tela | Contrato definido em `SPEC.md` 5.5; capacidades desligadas até o Rust implementar |
| Desktop: Picture-in-Picture | Não prometido: o vídeo é um `<canvas>` e o PiP de `captureStream` não é confiável nos WebViews |

**Ressalvas:** o ajuste fino da porta de ruído com voz e microfone reais, a nitidez e o custo reais de cada preset de tela (CPU de quem
transmite e banda de saída do VPS de 1 CPU) e o PiP em navegador de verdade só podem ser julgados por você (`VALIDACAO-MANUAL.md`, seção
"Adicionais"). O E2E de voz (`apps/web/e2e/voice.spec.ts`) não precisou de ajuste: o botão "Compartilhar" do diálogo segue igual (não
executado: exige LiveKit local).


## Responder, editar com ↑ e fixar mensagens (qualidade de vida, backend + web)

**Pedido:** "responder a mensagens (com citação), editar a última mensagem com a seta para cima e fixar mensagens", como no Discord.

| Parte | Estado |
| --- | --- |
| Migração aditiva `00007` (`reference_id`, `pinned_at`, `pinned_by`, índice parcial das fixadas) | Feita, aplicada pelo deploy; só colunas `NULL` |
| `POST /messages` com `reply_to` e `mention_reply`; `reply_to` e `pinned` no payload; prévia em lote (sem N+1) | Feito |
| `PUT`/`DELETE`/`GET /channels/{id}/pins` (permissão, DM, limite de 50, idempotência), `MESSAGE_UPDATE` ao fixar | Feito |
| Web: responder (barra, interruptor de `@`, citação clicável com carga de páginas anteriores), ↑ edita a última, fixar com painel no cabeçalho | Feito |
| Testes Go (unitários e integração com WebSocket real), Vitest/MSW e E2E Playwright | Feitos; E2E executado no Docker (passou) |
| Menu de contexto, thread, evento de lista de fixadas | Não feito (a barra de ações cumpre o papel; ver `SPEC.md` 5.5) |

**Decisões:** o autor respondido é mencionado reaproveitando a resolução de `@username` (mesma regra de visibilidade); `reply_to` é `oneOf [ReplyPreview, null]` escrito à mão porque o huma não gera nullable para objeto; fixar publica só `MESSAGE_UPDATE`; apagar uma fixada a desafixa; cada mensagem virou focável (`tabIndex=0`) para as ações e os atalhos R, P e E funcionarem pelo teclado.

**Ressalvas:** a edição da original não republica as respostas no servidor (o cliente em tempo real atualiza o trecho; o histórico recarregado traz o texto novo). Aparência, teclado com IME, leitor de tela e o push da menção da resposta só você consegue validar (`VALIDACAO-MANUAL.md`, seção "Adicionais"). Na máquina de desenvolvimento, `pnpm build` do web falha hoje por erros de tipo em `features/voice` (trabalho paralelo de voz); o E2E usou `vite build` direto.

## Desktop: volume, porta/teste de microfone, qualidade da tela, bandeja e afins (qualidade de vida)

**Pedido:** levar para o app nativo (Rust/Tauri) o que o web já fazia (volume por pessoa, porta de ruído, medidor e teste de microfone,
qualidade da tela) e a "casca" de um app de computador: bandeja do sistema, início com o sistema, contador no ícone e abrir o canal certo
ao clicar na notificação.

| Parte | Estado |
| --- | --- |
| Volume por pessoa até 200% (voz e áudio da tela, 0 = mudo só para mim, rampa sem estalo, reaplicado ao republicar) | Feito; mixer testado sem hardware |
| Porta de ruído (automática/manual, lookahead, hold, release, histerese) depois do NS/RNNoise | Feito; porta fiel do worklet, testada sem hardware |
| Medidor de nível (evento ~20x/s) dentro e fora da chamada (captura de prévia) | Feito; precisa de teste com microfone real |
| Teste de microfone (grava ~5 s, toca no alto-falante escolhido, recusa com o microfone aberto na chamada) | Feito; precisa de teste com hardware |
| Qualidade da tela (720/1080/1440, 15/30/60 fps, nitidez x fluidez, teto de bitrate) | Feito; padrão igual ao de antes; 60 fps/1440p não medidos |
| Picture-in-Picture no desktop | Não prometido (vídeo em `<canvas>`) |
| Bandeja (menu, tooltip, alternar), fechar para a bandeja com aviso único, sair desconectando a voz | Feito; compilar/ver nos três SOs |
| Iniciar com o sistema e iniciar minimizado | Feito (padrões desligados) |
| Contador no ícone (Dock, ícone sobreposto no Windows, tooltip/título da bandeja) | Feito; Linux depende do ambiente |
| Clicar na notificação abre o canal | Heurística de foco (10 s); alt-tab no prazo também navega |
| Tela `/settings/app` com os interruptores | Feito (só no desktop) |

**Decisões que valem o seu olho:** o medidor e o teste recebem um canal de eventos próprio (o contrato original só tinha `{ enabled }`, mas fora
de chamada não existe o canal da sala); a porta desligada passa o áudio intacto e sem atraso (o web mantém 10 ms); "iniciar minimizado" só vale
quando o SO abre o app sozinho; `window-state` deixou de restaurar a visibilidade da janela.

**Ressalvas:** nada de áudio, bandeja, badge ou autostart foi ouvido/visto em hardware real aqui. A lógica pura (mixer, porta, qualidade, buffer
do teste, configurações, ícone do contador) passa nos testes; a integração com libwebrtc, cpal, scap e Tauri só é compilada pelo workflow
Desktop. No Linux/GNOME a bandeja precisa da extensão AppIndicator. Roteiro de teste por SO em `VALIDACAO-MANUAL.md`, "Adicionais".


## Status (Não perturbar, Invisível, personalizado) e silenciar/nível de notificação (qualidade de vida, backend + web)

**Pedido:** "status Não perturbar, Invisível e status personalizado (texto, emoji, expiração)" e "silenciar servidor/canal/DM por 15 min, 1 h, 8 h, 24 h ou até reativar, com nível tudo/só menções/nada", como no Discord.

| Parte | Estado |
| --- | --- |
| Migração aditiva `00008` (`users.status_pref` e status personalizado; tabela `notification_settings`) | Feita; só colunas com default constante ou `NULL` e uma tabela nova |
| Status: online, `dnd`, `invisible` (offline para os outros, conexão e voz intactas), ausente automático | Feito (backend + web) |
| Status personalizado (texto até 128, emoji, expira em 30 min/1 h/4 h/hoje/nunca), expiração no servidor sem job | Feito |
| `PATCH/GET /users/@me/presence`, `PRESENCE_UPDATE` com `dnd` e `custom_status`, `READY.self_presence`, `PRESENCE_SELF_UPDATE` entre abas | Feito |
| `notification_settings`: `GET/PUT/DELETE`, `READY.notification_settings`, `NOTIFICATION_SETTINGS_UPDATE` entre abas | Feito |
| Push e avisos respeitam DND, silêncio (com vencimento sem job) e nível; contagens de não lidas continuam | Feito (push: 1 consulta para todos os destinatários) |
| Web: seletor de status, diálogo de status personalizado, custom status em membros/DM/rodapé, menus "Silenciar por..." e de nível (servidor, canal, DM), indicadores, cartão "Silenciados e níveis" | Feito |
| Testes Go (unitários e integração), Vitest/MSW e E2E Playwright | Feitos; E2E executado no Docker (passou) |
| Nível "tudo" ampliando o push em servidor; padrão de nível por usuário; DND agendado; som de aviso | Não feito (ver `SPEC.md` 5.5) |

**Decisões:** invisível só muda a visão pública (a máquina de conexão e o push por "tem sessão" ficam iguais); expiração do status avaliada na leitura com um `AfterFunc` por usuário conectado para o aviso em tempo real (sem River); `muted` + `muted_until` nulo para "até reativar"; herança canal -> servidor -> padrão (servidor "só menções", DM "tudo"); silêncio do servidor vale para os canais; `@everyone/@here` não existem no projeto, então a regra de menção direta já cobre a supressão; DND decidido pelo banco (vale para push com o app fechado); nenhum som existe hoje, então nada a suprimir.

**Ressalvas:** push real respeitando DND/silêncio, a aparência nos dois temas, o menu por botão direito (sem componente de menu de contexto, abre o mesmo menu de clique) e a expiração com o app fechado só você consegue validar (`VALIDACAO-MANUAL.md`, seção "Adicionais"). Menus de submenu foram testados no jsdom com clique direto no item (o jsdom fecha o submenu ao mover o ponteiro); o E2E real de menu de submenu cobre o servidor, não o submenu de nível.

## Painel administrativo /admin (backend + web)

**Pedido:** painel `/admin` com informações em tempo real, inspirado no admin do Antrax: dashboard (cartões, gráficos de 14 dias, ao vivo, contagens, LiveKit, aplicação e armazenamento), usuários, servidores e chamadas.

| Parte | Estado |
| --- | --- |
| Migration aditiva `00009` (`users.is_admin`; índice `messages(author_id)`) e bootstrap por `ADMIN_USERNAMES` (idempotente, só promove) | Feito; variável no `.env.example`, compose dev/prod, `write-env` do deploy e `deploy/README.md` |
| `/api/admin/{overview,live,system,users,servers,calls}` (401/403, spans OTel, sem dados sensíveis, cache com singleflight) | Feito |
| Chamadas ao vivo pelo LiveKit (`voice.Service.LiveRooms`, porta existente) e Prometheus do LiveKit (habilitado só na rede interna) | Feito; métricas de mídia (perda, jitter, RTT) dependem de tráfego real: ver `VALIDACAO-MANUAL.md` |
| Web: layout, dashboard, gráficos SVG com tabela, tabelas ordenáveis/busca/paginação, polling 5 s/30 s, link só para admin | Feito |
| Testes: Go unitário e integração, Vitest/MSW (15), E2E Playwright (executado no Docker; passou) | Feitos |
| Cenário k6 do admin | Não feito (opcional) |
| SSE/gateway para o ao vivo; verificados, login social, banimentos, amizades (não existem no Spook) | Não feito / não se aplica |

**Decisões:** polling em vez de SSE; cache de 30 s/5 s/60 s no servidor; períodos de mensagens pela PK Snowflake; "última atividade" = último login; sem promover automaticamente quem se cadastra com um username da lista (evita corrida por nome de admin). Detalhes em `SPEC.md` 5.5.

**Ressalvas:** a aparência nos dois temas e no celular, os números contra a produção e as métricas de mídia do Prometheus numa chamada real só o dono valida (`VALIDACAO-MANUAL.md`). Ordenar usuários por mensagens varre todos os usuários (~375 ms com 10 mil usuários e 175 mil mensagens); a ordenação padrão é rápida.

## Controles de voz no painel do usuário

Os controles de voz saíram da barra inferior da tela e foram para o rodapé da barra lateral (servidores e DMs, pois o `UserPanel` é compartilhado), como no Discord. Em chamada, um cartão "Voz conectada" (qualidade do enlace, canal, servidor, botão de sair, câmera e compartilhar tela) aparece acima da linha do usuário; na linha do usuário, ao lado do nome, ficam microfone, fone e Dispositivos (só em chamada), antes do seletor de status. A região continua com o nome "Controles de voz" (só existe em chamada). Fora da chamada, microfone e fone continuam disponíveis e só guardam a preferência no store (`toggleMute`/`toggleDeafen` agora atualizam o estado quando ocioso; ela vale na próxima entrada). Sem mudança no `VoiceEngine`, no desktop ou nos seletores do E2E. Código: `voice-bar.tsx` (`VoiceDock`, `VoiceCallCard`, `VoiceUserControls`) e `presence/user-panel.tsx`.

## Gerir administradores por SSH

`spook admin grant|revoke <username>` e `spook admin list` (subcomando do binário, `server/internal/admin/cli.go`) e `deploy/admin.sh`, que o
executa no contêiner `spook` do VPS (`ssh <vps> "sudo -iu spook /srv/spook/prod/deploy/admin.sh grant <username>"`). Vale na hora, sem redeploy;
aceita o username com ou sem `@`. Teste de integração `TestAdminCLIGrantRevokeList`. Em produção, o `nyak` foi promovido por esse comando.

## Segurança do /admin e do Invisível (01/11/2026)

**Pedido:** documentar e provar o controle de acesso do `/admin`, provar que o Invisível não vaza como online por nenhum caminho e atualizar SPEC e `VALIDACAO-MANUAL.md`.

- **Admin:** nenhuma brecha achada. Teste novo enumera todas as rotas `/api/admin/**` do OpenAPI (401 sem sessão, 403 comum, 2xx admin), cobre Bearer do desktop, rebaixar na hora e que nenhum evento de admin existe no gateway. O `ci-entry.sh` do VPS segue com 3 operações (conferido em 01/11, arquivo de 31/10). Cloudflare Access documentada, não configurada.
- **Invisível:** 3 brechas do gateway corrigidas (RESUME depois que a presença expirou aparecia online; corrida de PATCH entre READY e `Connect`; corrida do snapshot do READY) e 7 testes de integração novos.
- **SPEC:** RF13 a RF21, regras 7.9, mapa de migrations 00001 a 00009 e exclusões atualizadas. `VALIDACAO-MANUAL.md`: 46 itens agrupados.

## Compartilhar tela simples, prévia da transmissão e assistir (02/11/2026)

**Pedido:** o diálogo de compartilhar tela (4 presets mais "opções avançadas") não agradou. Pesquisa no Discord (central de ajuda, artigo 360040816151): dois seletores (resolução e fps), "Ocultar prévia da transmissão" e um cartão com miniatura e botão de assistir ao passar o mouse no selo de tela do participante.

- **Diálogo:** Resolução (720/1080/1440p), Taxa de quadros (15/30/60), Incluir áudio (desligado) e Mostrar prévia para o canal (ligado). Presets e opções avançadas removidos; prioridade derivada do fps; mesmo contrato do engine; escolha persistida e chave antiga migrada. **Padrão 1080p/30 fps** (5 Mbps; o do Discord é 720p/30), mais caro que o 1080p/15 anterior: decisão registrada no SPEC para o dono reavaliar.
- **Prévia:** a web envia uma miniatura JPEG 320x180 (até 40 KB) ao entrar e a cada ~15 s; o backend guarda em memória por 45 s (200 prévias / 12 MB no máximo, 1 envio a cada 5 s por usuário) e serve só a quem vê o canal. Novos endpoints `PUT`/`DELETE`/`GET /api/channels/{id}/voice/screen-preview[/{user_id}]` e o campo `screen_preview` no voice state. Sem SQL nem migration.
- **Assistir:** cartão (hover/foco/toque) com miniatura, "Tela de X", "Ao vivo" e "Assistir transmissão" na lista de canais e na chamada de DM; entra no canal e põe a tela em foco no palco (espera até 10 s a tela chegar). Opção local "Mostrar prévias das transmissões" (padrão ligado) em Configurações > Voz e vídeo.
- **Desktop:** seletores de resolução e fps iguais; a prévia fica desabilitada (`screenSharePreview: false`).
- **Verificação:** ver SPEC 5.5 (testes) e `VALIDACAO-MANUAL.md` ("Voz: compartilhar tela simples, prévia e assistir transmissão"). Não provado: miniatura de uma tela real, peso real, celular e desktop.
