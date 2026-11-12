# Relatório dos adicionais (fora do SPEC)

Tudo aqui foi pedido **depois** do checkpoint `checkpoint-spec-completo` (commit `e39b794`, 31/10/2026). A lista bruta sai de
`git log checkpoint-spec-completo..HEAD`. Este arquivo é atualizado a cada adicional e vira o relatório final.

## Resumo executivo final (03/11/2026)

Desde o checkpoint `checkpoint-spec-completo` (`e39b794`, 31/10/2026) entraram **41 commits em `main`**: **845 arquivos, +106,7 mil / −4,8 mil linhas** sem contar as capturas de tela de `docs/design` (servidor Go: 226 arquivos, +38,4 mil / −1,7 mil; `apps/web/src`: 375 arquivos, +46,4 mil / −2,8 mil; o resto é documentação, testes E2E, deploy, desktop e `packages`). A API passou de **51 para 116 operações** (+65 endpoints, contra `server/api/openapi.yaml`). Tudo é adicional ao SPEC (RF13 a RF29) e nada estava nas fases 0 a 7.

| Bloco | O que entrou | Commits principais |
| --- | --- | --- |
| 1a leva (qualidade de vida) | ruído/eco/ganho, volume por pessoa, teste de microfone, status (DND/Invisível), silenciar, responder/fixar/editar, bandeja e contador no desktop, qualidade da tela e PiP, `/admin` e `spook admin` | `cbc3db1`, `915a713`, `fb060e8`, `6431522`, `9518246`, `44a834d`, `80cbda9`, `48a7fa2`, `cb7ec7f` |
| Repaginação visual | design system, shell responsivo, chat, configurações em tela cheia, palco de voz, diálogos, DMs e estados | `d3ba496` a `02eff4d`, `17d2f41` |
| Voz e mensagens | compartilhar tela simples, prévia e "Assistir", menus de dispositivo, sons de evento, layouts, trocar fonte, rede, autocomplete de `@`, cartão de convite | `b2fe103`, `f4b8a91` |
| Contas e perfil | trocar senha, confirmar senha, excluir conta, usernames reservados, bio, pronomes, banner, avatar animado | `779aa38` |
| Desktop | auto-update assinado, splash, página `/download`, aviso de nova versão do web | `ad5fb77` |
| Admin | biblioteca de gráficos (séries, barras, medidores, sparklines, heatmap), histórico do LiveKit, disco e plano | `d42460e`, `38364bb` |
| E-mail e login social | verificação, troca de e-mail confirmada, recuperação de senha, Google/Discord, login do desktop por navegador (inclui o deep link `spook://` no Rust; compilação conferida pelo workflow Desktop) | `5d7f7ee`, `c21a42e` |
| Moderação | banir/desbanir, permissões por canal, apelido, mutar/desconectar na voz, registro de auditoria | `66bfd26` |
| Menções e limites | `@everyone`/`@here`/cargo, mensagem de entrada, tópico, `LIMIT_*`, exclusão de servidor com senha | `e30ee5b` |
| Social | amizades, bloqueio, presença de amigos, convite pela DM, chamada em DM com toque | `20fed91` |
| Voz no backend e rate limits | espectadores, reconciliação por job, limites nomeados (`RATELIMIT_*`), histórico do admin | `38364bb` |
| i18n | interface em pt-BR e inglês, 1660 chaves por idioma, paridade testada | `cb28eb3` |

**Migrations (todas aditivas):** `00007_reply_pins`, `00008_status_notifications`, `00009_admin`, `00010_account_profile`, `00011_email_social`, `00012_moderation`, `00013_mentions_topic_system`, `00014_social`, `00015_voice_admin_history` (não há `00016`).

**Decisões que merecem seu olho:** DM 1:1 segue aberta a quem compartilha servidor e também a amigos (SPEC 7.4 atualizado); bloqueio é silencioso para quem foi bloqueado; mensagens de conta excluída ficam como "Usuário removido"; contas sociais nunca se vinculam por e-mail automaticamente; contas antigas ficam "não verificadas" sem perder acesso; canais não herdam permissões da categoria; banir não revoga convites; padrão 1080p/30 fps no compartilhamento de tela; idioma só no navegador; limites de domínio e de taxa são valores meus (listados em `PENDENCIAS-DONO.md`, seção C2); estado de voz em memória assume uma única instância do backend.

**Limitações:** o deep link `spook://` (login do desktop por navegador) só foi validado por testes de lógica e type-check em Linux, falta o teste nos três SOs (`VALIDACAO-MANUAL.md`); no desktop também faltam assinatura por faixa, troca de fonte e estatísticas de rede; Rust do idioma da bandeja não foi compilado localmente; inglês não revisado por nativo; push em pt-BR; `/admin` só em pt-BR; Fase B (benchmarks) e observabilidade em produção não executadas; SMTP, apps OAuth e certificados de assinatura dependem de você.

**Fora por decisão do dono:** soundboard, 2FA, código de cadastro e mobile (Expo); push-to-talk, Ctrl+K e rascunho por canal (1a leva).

**O que só você valida / pendências:** `PENDENCIAS-DONO.md` (passo a passo, por prioridade) e `VALIDACAO-MANUAL.md` (roteiros por fase). Resultado do plano item a item: `PLANO-ADICIONAIS-2.md` (seção "Status da execução"). Revisão visual final e acessibilidade: `docs/design/README.md` e `docs/design/a11y-check.txt`.

## Resumo executivo da primeira leva (01/11/2026)

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

## Gráficos do admin (02/11/2026)

**Pedido:** o `/admin` era quase só tabela; o dono quis visual melhor (item 7.1 do `PLANO-ADICIONAIS-2.md`).

- **Biblioteca de gráficos própria** (`components/charts/`): série temporal com comparação, barras horizontais, medidores, sparklines e heatmap, todos com tabela acessível, estado vazio, esqueleto, balão por hover/foco e tokens do design system.
- **Dashboard** reorganizado em grupos; cartões com seta e variação; sparklines acumuladas no cliente; medidores de memória, pool, perda de pacotes e jitter; barras das maiores tabelas e do armazenamento. **Chamadas** com barras de pessoas e duração.
- **Depende do backend:** disco, histórico do LiveKit (7.2) e mensagens por hora (o heatmap está pronto, sem uso). Ver `PENDENCIAS-DONO.md` e SPEC 5.5.
- **Verificação:** ver SPEC 5.5 ("Adicional: gráficos do admin").

## Desktop: atualização automática, download e aviso de versão (02/11/2026)

**Pedido:** itens 6.1 a 6.4 do `PLANO-ADICIONAIS-2.md` (auto-update do desktop, tela de abertura, página de download, aviso de nova versão do web).

| Parte | Estado |
| --- | --- |
| Atualizador assinado (`tauri-plugin-updater`/`process`), verificação ao abrir e a cada 6 h, download em segundo plano, "Reiniciar para atualizar", nunca em chamada sem confirmar | Feito (compilação do Rust só no workflow) |
| Tela de abertura "Verificando atualizações…" (≤ 1,5 s, offline ok, mostra o download) | Feito |
| Seção "Atualizações" em `/settings/app` e toast discreto | Feito |
| Workflow Desktop assina os bundles e gera o `latest.json` no release rascunho | Feito (3 de 4 builds já passavam; macOS agora gera também o `.app.tar.gz`) |
| `/download` pública (SO detectado, 4 destinos, tamanho, versão, data, SHA-256, instruções e aviso de app não assinado) + links "Baixar o app" | Feito |
| `version.json` no build, banner "Nova versão disponível" (foco e 10 min; só web) | Feito |
| Página estática de fallback gerada no deploy | Não feito (opcional) |
| `.msi` e `.rpm` | Não existem: o workflow só gera `.exe`, `.dmg`, `.deb` e `.AppImage` |

- **Decisões:** API JS dos plugins (sem comandos Rust próprios); download automático e instalação só ao reiniciar; abertura como sobreposição no webview (sem 2ª janela); sem bump de versão (0.1.0).
- **Chave do updater:** par gerado fora do repositório; a pública está em `tauri.conf.json`. O dono precisa guardar a privada (perder = todo mundo reinstala à mão) e criar os dois secrets.
- **Pendências do dono:** publicar o release (rascunho), backup da chave, (opcional) certificados de assinatura Apple/Microsoft para acabar com os avisos do sistema. Ver `PENDENCIAS-DONO.md`.
- **Verificação:** ver SPEC 5.5 ("Adicional: distribuição e atualização do desktop...") e `VALIDACAO-MANUAL.md`. Não provado: a atualização real em cada SO, a assinatura e a compilação das 4 plataformas.

## Voz e mensagens, lote 2 (02/11/2026)

- **Entregue (web):** setinhas de dispositivo (rodapé e palco), sons sintetizados com configurações, escolha de quais telas assistir, layouts (Grade, Foco, Ocultar inativos), troca de fonte da tela, tela cheia com ociosidade (confirmada e completada), indicador de rede com RTT/perda/jitter, autocompletar de `@`, cartão de convite inline e "(editada)" com tooltip; "Ativar áudio" sem duplicidade e correção da captura `menu-de-membro` em 390.
- **Decisões:** setinha só no hover/foco (e botão direito/toque longo) para proteger o nome em 240 px; assinatura manual de telas na engine web (desktop continua assinando tudo); limiares de rede em SPEC 5.5.
- **Depende de backend:** menção a cargo e `@everyone`; espectadores por tela. **Desktop:** assistir/trocar fonte/estatísticas ficam desligados (capacidades ausentes).
- **Verificação:** ver SPEC 5.5 ("Adicional: voz e mensagens (lote 2)") e `VALIDACAO-MANUAL.md`.

## Contas e perfil (02/11/2026)

**Pedido:** Onda 1 do `PLANO-ADICIONAIS-2.md` (itens 1.1, 1.3, 1.7, 1.8, 5.1 a 5.3 e a parte sem e-mail do 1.2).

| Parte | Estado |
| --- | --- |
| Trocar senha logado (encerra as outras sessões e derruba o gateway delas; mantém a atual) | Feito |
| Confirmar senha ("modo sudo", 10 min) + `RequireRecentPassword` reutilizável + `useConfirmPassword()` | Feito |
| Trocar e-mail (com confirmação recente; troca direta, ponto de extensão para a verificação) | Feito; verificação por e-mail depende de SMTP |
| Excluir conta (recusa dono; anonimiza; mensagens ficam; arquivos por job; cascata em transação) | Feito |
| Usernames reservados (cadastro) | Feito |
| Bio, pronomes, banner (imagem ou cor) e avatar animado (GIF/WebP) | Feito |
| Editores em Configurações > Perfil, seção Segurança e cartão de perfil com banner/bio/pronomes | Feito |

- **Decisões:** mensagens permanecem com o autor `removido_<id>` ("Usuário removido"); convites criados continuam; DMs 1:1 continuam e grupos passam o dono; a confirmação de senha fica na sessão (banco); senha errada responde 422 (não 401); a senha do `DELETE` vale como confirmação. Detalhes no SPEC 5.5 ("Adicional: contas e perfil"), 6, 7.10 e RF23.
- **Pontos de atenção:** avatar e banner não são reprocessados (animação preservada, mas EXIF/GPS não é removido); arquivos antigos não são apagados ao trocar a imagem; excluir servidor ainda não exige a senha (o agente da Onda 2 aplica o `sensitive` já pronto).
- **Verificação:** Go (unitários, integração completa), Vitest, E2E `account.spec.ts`; ver o SPEC 5.5.

## E-mail e login social (03/11/2026)

**Pedido:** Onda 5 do `PLANO-ADICIONAIS-2.md` (itens 1.2 completo, 1.4, 1.5, 1.6 e 1.9).

| Parte | Estado |
| --- | --- |
| Mailer (`platform/mailer`): SMTP (STARTTLS/TLS), driver `log` e dublê; modelos pt-br (texto + HTML sem imagens remotas); envio por job River com retentativa e idempotência | Feito (SMTP real depende de credenciais) |
| Verificação de e-mail (token de uso único, reenvio com limite, faixa e página `/verify-email`) | Feito |
| Troca de e-mail confirmada no endereço novo (`EmailChangeVerifier`), com aviso ao antigo | Feito |
| Esqueci/redefinir senha (resposta idêntica, piso de duração, limites, encerra todas as sessões) + `spook admin reset-password` | Feito |
| Login social Google e Discord (OAuth2 + PKCE, vínculo por e-mail verificado do provedor [atualizado, ver "Login social em conta existente e sessão persistente"], escolher username, vincular/desvincular, último método, definir senha) | Feito (falta criar os apps OAuth) |
| Login do desktop pelo navegador (backend, páginas web, módulo `browser-login.ts` atrás da capability `browserLogin`, ligada só no build do desktop) | Feito: backend, páginas web, `tauri-plugin-deep-link` (esquema `spook`, instância única, validação em Rust), botão com estados e `VITE_DESKTOP_BROWSER_LOGIN=true` no build do desktop; **falta validar nos 3 SOs** |
| Modo degradado sem SMTP (documentado) e `REQUIRE_EMAIL_VERIFICATION` | Feito |

- **Decisões:** contas antigas "não verificadas" sem bloquear nada (padrão); sem `SMTP_HOST` o app sobe com o driver `log` e os fluxos por e-mail ficam desligados; token cifrado nos args do job (nunca em claro no banco); Google lido por `userinfo`, não por JWKS; vínculo por e-mail só quando o provedor o verificou (regra original "nunca vincular" substituída em 07/11/2026); contas sociais nascem sem senha (`password_hash = '!'`) e definem uma depois com reautenticação social; `SPOOK_SECRET_KEY` opcional (chave efêmera por processo se faltar). Detalhes e modelo de ameaça em SPEC 5.5 ("Adicional: e-mail e login social"), RF24, 6 e 7.11.
- **Pontos de atenção:** `GET /api/users/me` e login/cadastro ganharam `email_verified`, `has_password` e `pending_email`; `PUT /users/me/email` pode responder 202; o River agora sobe sempre (antes só com storage ou push); o teste `TestFullAccountFlow` deixou de proibir a palavra "password" (agora proíbe o campo `"password"`, `password_hash` e `argon2`); sem `SPOOK_SECRET_KEY` em produção, reinícios derrubam fluxos OAuth em andamento.
- **Verificação:** Go (unitários, `golangci-lint` v2, integração completa), Vitest, E2E `e2e/email-recovery.spec.ts`; ver o SPEC 5.5 e `VALIDACAO-MANUAL.md`.

## Moderação e permissões (03/11/2026)

Itens 3.1 a 3.5 do `PLANO-ADICIONAIS-2.md`: banir e desbanir com motivo, permissões por canal (canal privado), apelido por servidor, mutar e desconectar na voz, e registro de auditoria. Migration `00012_moderation`; requisitos em RF25, regras em 7.12 e decisões em 5.5 do `SPEC.md`.

- **Backend.** Novo pacote `audit`; `perm` com resolução por canal e hierarquia genérica (`CanModerate`); `channel` com overwrites e visibilidade; `guild` com bans, apelido e mute; `voice` com `server_muted` e desconexão; gateway e notificações passam a usar a permissão efetiva do canal.
- **Web.** Abas Banimentos e Auditoria, diálogos de banir e apelido, editor "Permissões" do canal, moderação de voz e aviso de banido no convite.
- **Testes.** Unit (`perm`, `channel`, `guild`, `gateway`), integração (`app/moderation_integration_test.go`: matriz, hierarquia, vazamento, gateway, voz com LiveKit falso, auditoria, retenção, rate limit), Vitest e E2E `moderation.spec.ts`.
- **Pendências.** Ver `PENDENCIAS-DONO.md` ("Moderação e permissões").


## Menções em massa, mensagem de entrada, tópico, limites e senha para excluir (03/11/2026)

Itens 4.x do `PLANO-ADICIONAIS-2.md`. Migration `00013_mentions_topic_system`; requisitos em RF26, regras em 7.13 e decisões em 5.5 ("menções, mensagem de sistema, tópico e limites").

- **Backend.** Permissão `MENTION_EVERYONE` (bit 19), cargos `mentionable`, parser `ParseBulk`, alcance por visibilidade/presença/cargo, supressão por servidor, push com DND/silêncio/nível, limite de fan-out (`EVERYONE_PUSH_MAX`) e rate limit 1/30 s; mensagem `member_join` (`messages.kind`, canal de sistema e interruptor no servidor); `channels.topic`; pacote `platform/limits` com `LIMIT_*`; `sensitive` (senha recente) em excluir servidor e transferir posse. Endpoints/campos novos: `PATCH /api/channels/{id}` (`topic`), `PATCH /api/guilds/{id}` (`system_channel_id`, `system_join_enabled`), cargos (`mentionable`), `PUT notification-settings/guild/{id}` (`suppress_everyone`), mensagem (`kind`, `mention_everyone`, `mention_here`, `mention_roles`).
- **Web.** Pílulas de `@everyone`/`@here`/cargo, destaque, autocomplete por permissão, editor de cargo, "Suprimir @everyone e @here", linha de entrada, tópico no cabeçalho e no diálogo "Editar canal", configuração das mensagens de entrada e exclusão do servidor com nome + senha.
- **Testes.** Unit (parser, matriz de permissão, quem notifica quem com overwrites/invisível/DND/silêncio/nível/fan-out, supressão, rate limit, mensagem de sistema, tópico, limites, config), integração (`app/mentions_integration_test.go`; os testes antigos ganharam a mensagem de entrada e a confirmação de senha), Vitest `mentions-system.test.tsx` e E2E `e2e/mentions.spec.ts`.
- **Pendências.** Ver `PENDENCIAS-DONO.md` ("Menções, mensagem de entrada e limites").

## Social: amizades, bloqueio, presença de amigos, convite pela DM e chamada com toque (03/11/2026)

Seção 2 do `PLANO-ADICIONAIS-2.md`. Migration `00014_social`; requisitos em RF27, regras em 7.4 (atualizada) e decisões em 5.5 ("Adicional: social").

- **Decisão de produto.** DM 1:1 continua liberada a quem compartilha servidor e também a amigos; bloqueio impede DM e chamada nos dois sentidos, mensagens antigas ficam, mensagens novas em DM 1:1 com bloqueio são recusadas com erro genérico, e em grupos o cliente recolhe as mensagens do bloqueado. Bloquear desfaz a amizade e cancela pedidos.
- **Backend.** Pacotes novos `relationship` (amizades, bloqueios, convite pela DM) e `dmcall` (toque em memória com relógio injetável); `dm`, `message`, `notification` (bloqueio em menções/avisos, `CallRecipients`, push de chamada), `presence` (amigos), `invite` (`Share`), `voice` (bloqueio e `Occupants`), `account` (limpeza) e `gateway` (`relationships` e `calls` no READY, eventos `RELATIONSHIP_*` e `CALL_*`) foram estendidos. Rate limits: pedidos de amizade (`friends.request`), demais ações sociais e ligações (`call.ring`).
- **Web.** Tela `/channels/@me/friends`, selo de pedidos, cartão de perfil com ações por relacionamento, cartão de chamada recebida (`alertdialog`), "Chamando…/Em chamada", mensagens de bloqueados recolhidas e Configurações > Bloqueados.
- **Testes.** Go: unitários (`relationship`, `dmcall` com relógio falso, `dm`, `message`, `notification`, `presence`, `invite`, fixtures do gateway), integração (`app/social_integration_test.go`: matriz de bloqueio, limites de 200/1000, eventos só aos envolvidos, presença sem servidor em comum, convite, ligações com LiveKit falso) e `golangci-lint`; web: Vitest (`social.test.tsx`, `features/social/store.test.ts`, contrato do gateway) e E2E `e2e/social.spec.ts`.
- **Pendências.** Ver `PENDENCIAS-DONO.md` ("Social") e `VALIDACAO-MANUAL.md` ("Social: amizades, bloqueio...").

## Voz no backend, histórico do admin e rate limits (03/11/2026)

Itens 4.6 e 4.13 e 7.1 a 7.4 do `PLANO-ADICIONAIS-2.md`. Migration `00015_voice_admin_history`; requisitos em RF28, regras em 7.14 (tabela de rate limits) e decisões em 5.5 ("Adicional: voz no backend, histórico do admin e rate limits").

- **Espectadores da transmissão.** O cliente avisa o backend com `PUT|DELETE /api/channels/{id}/voice/screen-watch/{user_id}` (heartbeat de 20 s, validade de 45 s, registro em memória sem goroutine); o voice state de quem transmite ganha `viewer_count` (todos que veem o canal) e `viewers` (até 50, **só o transmissor**: o gateway e os snapshots retiram a lista dos demais). Web: "Assistindo: N" com avatares e tooltip de nomes no tile e no cartão da transmissão.
- **Reconciliação da voz.** Job River `voice_reconcile` (60 s) com métricas `spook.voice.reconcile.*`: registra participantes desconhecidos, remove órfãos, corrige câmera/tela/prévia/espectadores fantasma, reaplica mute do servidor e reavalia permissões; tolera o LiveKit fora do ar e nunca desconecta por engano.
- **Rate limits nomeados.** Inventário completo em 7.14; limites novos para criar servidor, canal, convite, cargos, token de voz, avisar espectador, editar perfil e fixar; métrica `spook.ratelimit.blocked{name}`; `RATELIMIT_<NOME>_PER_MIN` opcional; 429 com `Retry-After` documentado no OpenAPI.
- **Admin.** Tabela `livekit_samples` (amostra por minuto do LiveKit e do gateway, retenção `LIVEKIT_SAMPLES_RETENTION_DAYS`), `GET /api/admin/livekit/history|usage`, `gateway/history`, `activity/heatmap` e `servers/top`, disco (`ADMIN_DISK_PATH`) e bytes do S3 em `/system`; web com mapa de calor, séries de participantes/tráfego/gateway com seletor 24 h / 7 dias / 30 dias, ranking de servidores, medidores de disco e de plano, "Coletando dados…" e os avisos antigos removidos.
- **Testes.** Go: unitários com LiveKit/Prometheus/S3 falsos e relógio falso (`voice` watch e reconciliação, `admin` histórico/uso/cache/disco, `gateway` filtro de `viewers`, `config`, `app/limits_test.go`), integração (`app/voice_admin_history_integration_test.go`: espectadores ponta a ponta com webhooks, reconciliação, 401/403/200 dos endpoints novos, deltas com reinício de contador, limites e cache, rate limits com 429); Vitest (`admin.test.tsx`, `screen-watch.test.ts`, `viewers.test.tsx`, `stream-card.test.tsx`).
- **Pendências.** Ver `PENDENCIAS-DONO.md` ("Voz no backend, histórico do admin e rate limits") e `VALIDACAO-MANUAL.md` (RF28).

## Idiomas pt-BR e inglês (03/11/2026)
- Módulo próprio `apps/web/src/i18n/` (sem biblioteca): `t`/`useT`, interpolação, plural por `Intl.PluralRules`, fallback para pt-BR, formatação por idioma, `<html lang>`; 1660 chaves por idioma em 10 catálogos tipados.
- Cobertura: auth, shell, canais, chat, membros, perfil, configurações, diálogos, DMs/amigos, voz/palco, notificações, download, erros e validação (Zod); admin só em pt-BR (justificado no SPEC).
- Idioma: `localStorage` -> `navigator.language` -> pt-BR; seletor em "Aparência e idioma" e no menu do usuário; troca ao vivo. Sem mudança no backend nem no contrato.
- Erros do servidor traduzidos por tabela de `detail` (~100) e `code`; push segue em pt-BR; bandeja do Tauri traduzida via `app_set_locale` (Rust não compilado).
- Testes: paridade de chaves/placeholders, varredor de literais pt-BR, módulo i18n, E2E `i18n.spec.ts`. Glossário no `apps/web/README.md`.
- Pendências: `PENDENCIAS-DONO.md` e `VALIDACAO-MANUAL.md` ("Idiomas pt-BR e inglês").

## Login social em conta existente e sessão persistente (07/11/2026)

Pedido do dono (2 mudanças). Migration `00016_session_persistence` (aditiva: `sessions.remember`, `sessions.last_seen_at`); requisitos em RF30, regras em 7.16 e decisões em 5.5 ("Adicional: login social em conta existente e sessão persistente").

- **Login social em conta existente.** Antes recusava (`email_in_use`). Agora, com e-mail **verificado pelo provedor** e igual ao da conta (sem diferença de caixa), vincula e entra; se o e-mail da conta não estava verificado, passa a estar e todas as outras sessões caem (mais a troca de e-mail pendente e os tokens de e-mail abertos), tudo numa transação, com log estruturado. Sem e-mail ou não verificado: recusa como antes. A regra "sem vínculo automático" do modelo de ameaça foi substituída; risco residual (a senha do invasor segue valendo) documentado e levado a `PENDENCIAS-DONO.md` (B10).
- **Sessão persistente.** Causa do "expira": prazo fixo de 30 dias sem renovação. Agora "Manter conectado" (padrão marcado): 90 dias deslizantes (teto de 365), cookie persistente; desmarcado: 24 h deslizantes (teto de 7 dias), cookie de sessão. Renovação no máximo 1 vez por hora (sem escrever a cada requisição), reenviando o cookie. Login social e desktop sempre usam sessão longa.
- **Sessões ativas** (Configurações > Perfil): lista com dispositivo aproximado (sem IP), criada em, último uso, "Esta sessão"; encerrar uma ou todas as outras exige a senha recente e derruba o gateway da sessão.
- **Decisões:** `remember` é `*bool` no contrato (o huma trocaria um `false` pelo padrão com `bool`); IP não guardado; sessões antigas viram "lembradas"; nenhum e-mail de aviso ao vincular (ideia futura).
- **Pontos de atenção:** o admin passou a mostrar "última atividade" pelo `last_seen_at` (antes, a criação da sessão); `Register` e `Login` do `auth.Service` ganharam o parâmetro `remember`.
- **Verificação:** ver o relatório da entrega (Go unitário, integração completa, Vitest, E2E curto).

## Backup e restauração do Postgres e do Garage (07/11/2026)

Pedido do dono. Decisões em 5.5 ("Adicional: backups"); questão em aberto 3 do SPEC fechada; operação em `deploy/README.md` seção 10. Nenhuma mudança no app nem no compose de produção (só um comentário); o `ci-entry.sh` do VPS **não** foi ampliado.

- **O que entrou:** `deploy/backup.sh` (pg_dump `-Fc` verificado + `aws s3 sync` do bucket pela API S3 do Garage + retenção 7/4/3 + lock + checagem de espaço + offsite opcional por `rclone`), `restore.sh` (banco novo; `--confirm-replace` renomeia o real para `*_pre_restore_*`), `restore-files.sh`, `backup-status.sh` (sai 1 se > 36 h), `install-backup-timer.sh` + `deploy/systemd/` (timer diário 04:00 UTC e check semanal), `backup-lib.sh` e `backup-selftest.sh`. `deploy.yml` (`write-env`) ganhou as Variables/Secrets opcionais `BACKUP_*` do offsite no R2.
- **Decisões:** dump lógico + API S3 (nunca copiar volumes do Garage ligado); espelho de arquivos só aditivo; criptografia por `rclone crypt` (sem `age`); RPO 24 h.
- **Verificação:** `deploy/backup-selftest.sh` (contêineres descartáveis) e shellcheck limpo; o resultado está no relatório da entrega.
- **Pendências do dono:** instalar o timer no VPS e, se quiser, criar o bucket/token do R2 (`PENDENCIAS-DONO.md`, B8). Não testado: instalação do timer e execução no VPS real.


## Latência da voz: anel de fala e entrada no canal (07/11/2026)

Pedido do dono (2 melhorias de latência percebida). Decisões em 5.5 ("Adicional: latência da voz (fala e entrada)"). Sem mudança de API, Go ou migrations.

- **A. Indicador de fala.** LiveKit com `audio: { update_interval: 200, smooth_intervals: 1 }` (dev e prod; o deploy recria o LiveKit e as chamadas em andamento caem por segundos). Cliente: hold anti-pisca de 250 ms nas identidades do servidor e anel do próprio usuário pela leitura local do microfone (nível pós-ruído/porta, ~60 ms para acender, histerese de 4 dB, hold de 250 ms), mesclado (OU) com o servidor; mudo nunca acende. Web e desktop (Rust: `callOnly` no medidor, não compilado localmente).
- **B. Entrada.** Medida por fase (`voice-join-perf.spec.ts`), depois: microfone + RNNoise/porta abertos em paralelo com token e conexão; `afterConnect` paralelo; item do próprio usuário já na lista do canal; pré-aquecimento (DNS/TLS do LiveKit e módulos) no hover; no Rust, mesmo preparo (`voice_prepare_microphone`) e logs de duração das fases.
- **Tempos (mediana de 10 entradas, ms desde o clique; LiveKit local no Docker, Chromium com mídia falsa).** "Pronto" = microfone publicado. "Simulado" = +120 ms no token e +250 ms para abrir o microfone (a rede local não mostra o que o usuário sente).

| Fase | Antes (local) | Depois (local) | Antes (simulado) | Depois (simulado) |
|---|---|---|---|---|
| token pedido -> recebido | 15 | 16 | 137 | 137 |
| sinalização (WebSocket) aberta | 36 | 37 | 152 | 151 |
| conectado (ICE/mídia) | 86 | 88 | 203 | 202 |
| captura + processador (RNNoise/porta) | dentro de "mic" | 35 (em paralelo) | dentro de "mic" | 254 (em paralelo) |
| microfone publicado = pronto (Padrão) | 129 | 128 | 517 | 291 |
| pronto (Forte + porta) | 141 | 132 | 529 | 291 |
| confirmação do gateway (webhook) | 54 | 57 | 166 | 166 |
| `voice.token` no servidor (Server-Timing) | 1 | 1 | 1 | 1 |

  Ganho real = o que a abertura do dispositivo custa, que passa a sobrepor o token e a conexão (-226 ms a -238 ms no cenário simulado); na rede local, sem custo de dispositivo, nada muda (esperado). A 1ª entrada de uma sessão fria (baixar RNNoise/worklet) não entra na mediana e é coberta só em parte pelo pré-aquecimento do hover.
- **Não feito (de propósito).** Pré-buscar o token: emissão tem efeito no servidor (7.7) e gastaria o limite de 30/min.
- **Pontos de atenção.** (1) Toda chamada com microfone aberto passa a ter o grafo de áudio da web (~10 ms de lookahead + CPU baixa), para medir o nível; (2) o preparo abre o microfone no clique, antes de saber se a conexão dará certo (descartado se falhar); (3) latência real do anel em chamada com duas pessoas e o preparo do desktop só se validam à mão (`VALIDACAO-MANUAL.md`).


## Seletor de tela com miniaturas e borda da captura (07/11/2026)

Pedido do dono (2 itens, só app desktop). Decisões em 5.5 ("Adicional: seletor de tela com miniaturas e borda da captura (desktop)"). Sem API, Go ou migrations.

- **Seletor com miniaturas.** Grade de cartões 16:9 com prévia, ícone e nome, seções Telas/Janelas, `radiogroup` acessível (setas, Espaço, Enter, duplo clique), skeleton, "Sem prévia", aviso de privacidade e, no macOS sem permissão, mensagem com botão para abrir os Ajustes. Miniaturas pelo Rust (`voice_screen_source_thumbnails`: sequencial, thread própria, `catch_unwind`, timeout 2,5 s, JPEG ≤ 40 KB, só local), atualizadas a cada 3 s com o diálogo aberto e canceladas ao fechar. Windows: captura única (cada captura acende a borda amarela). Ícone do app não feito (o scap não expõe).
- **Borda amarela do Windows: não resolvida, documentada.** O `scap` 0.0.8 fixa `DrawBorderSettings::Default`; o `windows-capture` 1.4.4 até tem `WithoutBorder`, mas a Microsoft exige `RequestAccessAsync(Borderless)` com a capability `graphicsCaptureWithoutBorder` no manifesto de app empacotado, e o instalador do Spook não é MSIX. Trocar a captura do Windows sem poder validar arriscaria regredir o que funciona. Caminho futuro: MSIX/pacote esparso.
- **Não compilado/verificado localmente:** o Rust de captura (só o workflow Desktop do CI compila), o comportamento real em macOS/Windows/Linux. Rodaram: Vitest, tsc, builds web/desktop, Biome, `rustfmt --check` e `cargo test` da lógica pura.


## Versão do desktop servida pelo backend (07/11/2026)

Pedido do dono: a `/download` falhava para quem está em rede compartilhada (limite de 60 req/h por IP do GitHub), com bloqueador de anúncios ou em rede corporativa. Decisões em 5.5 ("Adicional: versão do desktop servida pelo backend"). Sem migration nem SQL.

- **Backend.** Novo `GET /api/downloads/latest` (público, `server/internal/download`): consulta o último release no GitHub, normaliza (`version`, `published_at`, `page_url`, `installers[]`) e responde com `Cache-Control: public, max-age=60` e ETag. 404 sem versão publicada; 503 genérico se o GitHub falha e não há cache.
- **Cache.** Em memória, TTL 5 min, `singleflight`, revalidação por ETag do GitHub, stale-while-error por até 24 h (com log de aviso). Sem goroutine, sem persistência. Timeout 5 s, corpo até 1 MB.
- **Config.** `GITHUB_RELEASES_REPO` (padrão `devGustavoMuniz/spook`) e `GITHUB_TOKEN` (opcional, desnecessário). Documentadas em `.env.example` e `deploy/README.md`; o compose de produção as aceita vazias. O `write-env` do deploy NÃO as repassa: o GitHub Actions proíbe Variables/Secrets com prefixo `GITHUB_`.
- **Web.** Tenta o backend primeiro e cai para o GitHub direto só se o backend falhar (rede, 429, 5xx, corpo inesperado); 404 do backend = "ainda não há versão". Estados de erro, cache e textos da página inalterados.
- **Observabilidade.** Span `download.latest`; contador `spook.download.requests{outcome}`.
- **Ponto de atenção.** O cache é por processo: cada reinício do backend faz uma busca nova ao GitHub (uma só, por causa do `singleflight`). A medição em produção e o comportamento atrás do Cloudflare (`max-age=60`) só se validam no ar.


## Qualidade da tela compartilhada, tela preta e saída da chamada (08/11/2026)

Pedido do dono (testes reais do app desktop, três queixas). Decisões, tabela de medição e análise do publicador Rust em 5.5 ("Adicional: qualidade do compartilhamento de tela, tela preta e saída da chamada"). Sem API, Go, migration ou mudança no `livekit.yaml` (nada a recriar no deploy).

- **Qualidade (H1 confirmada, duas causas).** Web: simulcast na tela + `adaptiveStream` entregavam 960x540 em tile pequeno (agora 1920x1080 em qualquer tamanho; medido com E2E em duas builds). Desktop (a causa principal do relato): o vídeo remoto virava JPEG de no máximo 720p/15 fps/qualidade 70 (`limits.rs`); agora tela de outra pessoa = até 1080p, 30 fps, JPEG 88. O publicador Rust já estava correto (sem simulcast, bitrate da tabela, `degradation_preference`); foi só instrumentado (log de estatísticas a cada 5 s).
- **Diagnóstico.** Painel "Estatísticas da transmissão" no menu do tile (resolução, fps, taxa, codec, camada, assinatura, tempo até o 1º quadro e limitação do codificador de quem transmite).
- **Tela preta (H2).** Placeholder "Carregando transmissão…" até o 1º quadro real, "Tentar de novo" após 8 s, aviso de pausa; corrida de assinatura corrigida; tela estática no desktop deixava preto para quem entrava depois (o SDK Rust injeta quadros pretos até o 1º quadro real e o `scap` só entrega quando muda): o último quadro agora é reenviado a cada 500 ms; detecção de captura preta persistente com aviso ao transmissor.
- **Fechar o app (H3 confirmada).** Fechar a janela em chamada sai da chamada (desconexão graciosa, 3 s); opção "Manter a chamada ao fechar a janela" (desligada por padrão); tooltip "Em chamada". Fantasma de processo morto: ~15 s, fixo no LiveKit (ICE 10 s + 5 s), não configurável.
- **Arredores.** `leaveOnPageHide` não autenticava no desktop (fetch relativo sem Bearer): corrigido; assinatura "fantasma" ao assistir e parar rápido: corrigida.
- **Não feito / fora de escopo.** (1) ~~O desktop assina TODAS as telas da sala~~ Resolvido depois: ver "Telas sob demanda no desktop nativo". (2) JPEG 1080p/30 pelo IPC pode pesar em máquinas fracas (não medido). (3) Contagem de espectadores e estados "Conectando…" não foram revistos além do que o E2E exercitou. (4) VP9/H264 para tela não foram avaliados (dependem de encoder por plataforma).
- **Não compilado/medido:** todo o Rust (`core.rs`, `capture.rs`, `screen.rs`, `shell.rs`; só o workflow Desktop do CI compila) e a captura real em Windows/macOS. Rodaram: Vitest, `tsc`, build web e desktop, Biome, E2E de voz, `rustfmt --check` e `cargo test` da lógica pura (`blackdetect`, `limits`, `settings`, `quality`).
- **Achado do ambiente.** O contêiner `spook-set-server` (de uma tarefa anterior) tinha o mesmo alias de rede `server` e dividia as respostas do DNS com o servidor desta tarefa; o E2E rodou numa rede dedicada (`share2net`) para isolar.



## Configurações em modal e rolagem dos diálogos (08/11/2026)

Pedido do dono (2 itens, só web/desktop; sem API, Go ou migrations). Decisões em 5.5 ("Adicional: configurações em modal e rolagem do modal de voz") e em `docs/design/DESIGN-SYSTEM.md` ("Configurações" e "Diálogos").

- **Bug: o modal de configurações da chamada não rolava.** Causa raiz: o `ScrollArea` (Radix) do `DialogBody` tinha o viewport com `height: 100%`; num diálogo com só `max-height` a altura do pai não é definida e o `100%` virava `auto`, então o viewport crescia até o conteúdo (1074 px) e o `overflow-hidden` do pai só cortava (medido: `clientHeight` = `scrollHeight` = 1074 dentro de um corpo de 260/352/440/440 px nas janelas de 500/600/700/900 px). Corrigido no componente de base (`components/ui/scroll-area.tsx`: coluna flex, viewport `flex-1 min-h-0`, barra sempre visível quando há o que rolar, `overscroll-contain`), o que também conserta cargos e permissões de canal, que usavam o mesmo padrão. Testes E2E: `dialog-scroll.spec.ts` e `voice-dialog-scroll.spec.ts` (roda, Tab, arrastar a barra, clicar no último controle; 500/600/700/900 px; claro e escuro).
- **Configurações em modal estilo Discord.** Modal grande (`min(1100px,96vw)` x `min(760px,92svh)`; folha em tela cheia abaixo de 768 px com lista -> detalhe) sobre o app, que continua montado (voz, rolagem do chat). Menu agrupado (Conta: Perfil, Bloqueados; App: Notificações, Voz e vídeo, Aparência e idioma, Aplicativo só no desktop), "Sair" em vermelho, botão redondo Esc, menu e conteúdo com rolagem independente, setas no menu, foco preso e devolvido. As rotas `/settings/<seção>` seguem valendo como deep link: o estado é `?settings=` da rota atual, com a URL mascarada; fechar volta à rota anterior sem remontar.
- **Ponto de atenção.** Segurança (senha, e-mail, sessões, contas vinculadas, excluir conta) continua dentro de "Perfil" (não era seção própria). O Voltar do navegador agora fecha o modal. `return-path.ts` virou só a "última seção vista".
- **Não verificado aqui.** O WebView do Tauri (usa o mesmo código; só o build `build:desktop` foi conferido) e o comportamento em macOS/Windows reais.

## Palco com participantes recolhíveis e controles que somem (08/11/2026)

Pedido do dono (só front, web e desktop; sem API, Go ou migrations). Decisões em 5.5 ("Adicional: palco com participantes recolhíveis e controles que somem") e em `docs/design/DESIGN-SYSTEM.md` ("Palco de voz").

- **Recolher a faixa dos participantes.** Botão chevron centralizado na borda de baixo do palco (em tela cheia e fora dela) recolhe a faixa de quadrinhos e a tela compartilhada cresce; animação de altura/opacidade, `aria-expanded`, rótulo "Ocultar/Mostrar participantes", tecla P, escolha lembrada em `localStorage`. Recolhido, a fala de quem está na faixa acende o botão.
- **Auto-ocultar.** Hook `use-idle-controls` (relógio injetável): em tela cheia sempre e, fora dela, só com uma tela em foco, a barra, o botão de tela cheia e o de recolher somem após 3 s parados (fade + deslize; só fade com movimento reduzido) e o cursor some em tela cheia. Mouse, toque, tecla ou foco trazem de volta; menu/diálogo aberto, mouse sobre os controles ou foco neles seguram. Ocultos ficam `inert` + `aria-hidden`.
- **Botão de sair que muda de papel.** Compartilhando a tela vira "Parar de compartilhar"; assistindo a tela de alguém vira "Sair da transmissão" (para de assistir); fora disso segue "Sair da chamada". Vale na barra do palco e no cartão da lateral. Com o botão principal trocado, um botão secundário "Sair da chamada" fica sempre visível ao lado (nunca sem saída). No desktop nativo (sem escolha de telas) não há "Sair da transmissão".
- **Mudança de comportamento.** Antes a barra sumia em qualquer grade fora da tela cheia; agora fica fixa quando não há tela em foco (pedido do dono).
- **Não verificado aqui.** O WebView do Tauri (mesmo código; só `build:desktop`), cursor escondido em tela cheia nativa de macOS/Windows e toque em celular real.

## Recorte de avatar, banner e ícone (08/11/2026)

Pedido do dono: escolher a área exibida (estilo Discord) ao trocar foto de perfil/GIF, banner e ícone de servidor. Decisões em 5.5 ("Adicional: recorte de avatar e banner") e em `docs/design/DESIGN-SYSTEM.md` ("Diálogos").

- **Diálogo de recorte** (`components/image-cropper.tsx`, reutilizado nos três lugares): moldura na proporção real (1:1 com máscara circular/arredondada; banner 4:1), arrastar, pinça, roda do mouse, slider de zoom, prévia ao vivo nos tamanhos de uso, Cancelar/Aplicar, teclado (setas, +/-, Esc), foco preso, tela cheia no celular.
- **Estáticos:** recorte no navegador por canvas, EXIF aplicado, saída até 512x512 (banner 1280x320), sem ampliar. Bônus: o arquivo novo não carrega EXIF/GPS.
- **GIF:** o app só guarda o original, sem derivados nem lugar para o enquadramento; por isso há um endpoint novo (`POST /api/users/me/crop-image`) que recorta quadro a quadro com a stdlib do Go, preservando animação, atrasos e laço, **sem redimensionar** (a stdlib não tem quantizador). Limites de lado, quadros, volume, tempo e concorrência; 422 acima deles e o cliente cai no original centralizado, com aviso.
- **WebP animado e APNG:** não há como recortar sem recodificar e perder a animação (Go só decodifica WebP): usados como estão, com aviso no diálogo.
- **Não feito.** Girar; reduzir GIF; recortar de novo a partir do arquivo já enviado; apagar imagens antigas ao trocar.
- **Não verificado aqui.** WebView do Tauri (mesmo código; só `build:desktop`), toque/pinça em celular real, Safari/Firefox (E2E só no Chrome), GIFs reais grandes (só fixtures pequenas), qualidade visual do recorte em fotos reais.

## Perfil em tempo real e avatar GIF só ao falar (08/11/2026)

Pedido do dono (bug + feature; backend e web; sem migration, SQL ou mudança no OpenAPI). Decisões em 5.5 ("Adicional: perfil atualizado em tempo real e avatar GIF animado só ao falar") e em `docs/design/DESIGN-SYSTEM.md` ("Avatar").

- **Bug: nome e avatar novos só mudavam no painel do usuário.** Causa raiz: a edição de perfil não publicava evento nenhum e o cliente atualizava só a query do usuário atual; membros, autores de mensagens, DMs e relacionamentos guardam cópias, e a voz lê delas. Corrigido com o evento `USER_UPDATE` (tópicos: as outras sessões do usuário, cada servidor dele e quem divide DM ou amizade) e `applyUserUpdate` no cliente, que troca nome/avatar nos caches com `setQueryData`, sem refetch em massa. A chave do objeto muda a cada upload, então não houve problema de cache de URL.
- **Avatar GIF.** Parado (primeiro quadro, num canvas) em toda a interface; anima só enquanto a pessoa fala, dentro da chamada (tile do palco e lista de conectados da minha chamada, com o mesmo sinal do anel verde, inclusive o meu pela detecção local); sempre animado no cartão de perfil e na prévia de Configurações. `prefers-reduced-motion` nunca anima. Prop `animation="never"|"speaking"|"always"` no `Avatar`.
- **Por que canvas e não derivado no servidor.** Não há infraestrutura de derivados de avatar (o upload vai direto ao S3); um derivado pediria job, chave nova e backfill. O canvas custa uma carga por GIF (cache por URL sem a assinatura) e zero para não-GIF.
- **Não feito.** WebP/APNG animados (só GIF); manter o frame da animação ao parar/voltar a falar (reinicia).
- **Não verificado aqui.** WebView do Tauri (mesmo código; só `build:desktop`), Safari/Firefox, o caso de ficar offline durante a edição de outra pessoa (coberto pelo refetch do READY/resume, sem teste dedicado), fala real de microfone (o E2E usa o apito do microfone falso do Chromium).

## Chamados de feedback, sugestões e bugs (08/11/2026)

Pedido do dono: os usuários postam feedback, sugestões e bugs como chamados, e ele vê e responde pelo `/admin`. Decisões em 5.5 ("Adicional: chamados de feedback, sugestões e bugs"); modelo de dados na seção 6 (migrations 00017 e 00018).

- **Usuário.** Configurações > "Ajuda e feedback" (web e desktop): novo chamado (tipo Bug, Sugestão ou Feedback; título; descrição; contexto técnico opcional com prévia e opt-out), "Meus chamados" com estado (Aberto, Em análise, Respondido, Resolvido, Fechado), conversa, resposta, fechar e reabrir. Aviso ao vivo (`TICKET_UPDATE`) com toast e atalho quando a equipe responde.
- **Admin.** `/admin/tickets`: fila com filtros de estado e tipo, busca por título ou username, ordenação (movimento recente ou mais antigos), paginação por cursor e contagem de abertos no menu; detalhe com autor (nome, username, e-mail), contexto técnico, conversa, notas internas (invisíveis ao usuário), resposta e troca de estado.
- **Backend.** `server/internal/feedback` (handler -> service -> store), tabelas `tickets` e `ticket_messages`, limites 5 chamados por hora e 20 em andamento por pessoa, título 3-120, mensagem até 4000. Autorização no backend: autor só vê os seus (404 nos dos outros), nota interna nunca vaza, admin 401/403 genérico.
- **Anexos de captura de tela (feito depois, migration 00018).** Até 3 imagens (PNG, JPEG ou WebP, até 5 MB) ao abrir o chamado e a cada resposta, por botão, Ctrl+V ou arrastar; o admin as vê na conversa do /admin (miniatura que abre em tamanho cheio, inclusive nas notas internas, que seguem invisíveis ao usuário) e o usuário vê as da própria conversa. Backend: `POST /api/tickets/uploads`, chave `tickets/<chamado>/<id>.<ext>`, validação de tipo, tamanho e magic bytes reaproveitada do upload de mensagens, só autor e admin, URLs curtas, limite `tickets.upload`, teto de 3 por mensagem e 30 por chamado, job que apaga órfãos. Decisões em 5.5. Fila de upload do chat reaproveitada (sem duplicar).
- **Não feito.** Miniatura gerada no servidor para as capturas (hoje a imagem inteira, de até 5 MB, é reduzida por CSS); trilha de auditoria global do admin (a existente é por servidor); e-mail ao usuário quando a equipe responde.
- **Não verificado aqui.** Desktop (Tauri) com o formulário (mesmo código; só `build:desktop`), o contexto técnico lendo a versão nativa em um app real, Safari/Firefox (E2E só no Chrome) e o toast ao vivo em celular real.

## Telas sob demanda no desktop nativo (08/11/2026)

Pedido do dono: o app desktop deve se comportar como a web, assinando a tela de alguém só quando a pessoa clica em "Assistir". Decisões em 5.5 ("Adicional: telas sob demanda no desktop nativo"). Desktop Rust + web; sem backend, migration ou OpenAPI.

- **O que mudou.** O Rust conecta com `auto_subscribe = false` e assina à mão: voz e câmera sempre (como antes); vídeo e áudio de tela só de quem está em "assistindo". Novo comando async `voice_set_screen_watching(participant_id, watching)`; parar de assistir solta a faixa, o receptor de vídeo (decodificação e JPEG) e o áudio da tela. A engine nativa declara `screenWatch`, então "Assistir", "Parar de assistir", "Carregando transmissão…", "Tentar de novo", contagem de espectadores e o botão "Sair da transmissão" passam a valer no desktop (antes o botão nunca aparecia).
- **SDK.** livekit 0.10 só tem auto-subscribe da sala inteira (sem opção por faixa); por isso a assinatura é manual para tudo (evidência no código-fonte do crate, resumida no SPEC).
- **Verificado.** `cargo test` da lógica pura (`watch.rs`, 5 testes) e `rustfmt --check` em crate descartável; Vitest (`native-engine`, `voice-stage`, `controller-lote2`, `voice-stage-lote2`, `no-browser-webrtc`), `tsc --noEmit`, Biome na raiz e `vite build --mode desktop` (saída fora do repo).
- **Não verificado aqui.** A compilação do Rust com tauri/livekit (só no workflow Desktop do CI), qualquer execução com LiveKit real, a economia de banda/CPU e a latência até o primeiro quadro.
- **Não feito.** Prévia da própria tela no desktop que transmite (`screenSharePreview` segue falso); cenário de integração Rust para tela sob demanda.


## Ideias de recursos para Nitro e Nitro+

Pesquisa de 09/11/2026 (sem código) em `docs/NITRO-IDEIAS.md`: tabela do que o Discord dá no Nitro Basic, no Nitro e nos Server Boosts, o que o Spook já tem para virar privilégio, 30 ideias avaliadas (esforço, valor, infra, abuso), priorização em 3 ondas e cuidados de produto. Base obrigatória: módulo de entitlements por plano, checado sempre no backend. As 8 primeiras sugeridas: entitlements com concessão e códigos; tela 1080p/60 e 1440p por plano; avatar/banner animados; selo; upload maior com cota; mensagens mais longas; cor e estilo de nome; teste gratuito com expiração suave. Nunca vender moderação nem segurança.

## Nitro e Nitro+: núcleo do backend (09/11/2026)

Pedido do dono: planos pagos opcionais. Grátis = tela 720p/30 fps e GIF só estático; Nitro = 1080p/60 fps + GIF/WebP animado em avatar e banner + selo; Nitro+ = Nitro + 1440p. Esta entrega é a Task 1 do plano `docs/superpowers/plans/2026-11-09-nitro.md` (só backend e contratos); interface, admin visual e pagamento vêm depois. Decisões completas no SPEC (5.5 "Adicional: Nitro e Nitro+", 6, 7.14, 7.17, RF31).

- **Feito.** Pacote `plan` (matriz única + `Effective`/`Current`, fixture `packages/shared/fixtures/plans.json` gerada por teste); pacote `entitlement` (concessões, códigos de resgate, rotas da pessoa e do admin, job River de vencimento); migration `00019_entitlements` (`entitlements`, `redeem_codes`, função `user_plan`); `plan` em `GET /api/users/me`, autor de mensagem, membro, participante de DM, relacionamento e chamada de DM; eventos `ENTITLEMENT_UPDATE` e `USER_UPDATE.plan`; GIF/WebP animado/APNG sem Nitro -> 403 `nitro_required` em avatar, banner e `crop-image`; `plan` e `limits` no token de voz e silenciamento (melhor esforço) da tela acima do limite no webhook do LiveKit; OpenAPI, sqlc e orval regenerados; schema Zod e fixtures do gateway.
- **Decisões.** Códigos `SPOOK-XXXX-XXXX-XXXX-XXXX` com 80 bits, só o hash no banco (HMAC com `SPOOK_SECRET_KEY` quando há chave), texto mostrado uma vez; resgate atômico por `UPDATE ... WHERE redeemed_by IS NULL RETURNING`; dias somam à validade do mesmo plano ou de um maior (concessões independentes, o efetivo é o maior); o plano vence na hora (a consulta ignora a concessão vencida), o job só leva o aviso em tempo real; a conferência de animação do upload olha os bytes do arquivo (um GIF enviado como PNG também cai).
- **Testes.** Unitários (plan, entitlement, user, voice, gateway) e de integração em banco novo (`app/nitro_integration_test.go`: autorização, eventos, resgate concorrente com um único vencedor, rate limit por usuário e IP, `user_plan` SQL igual ao Go, job de vencimento, upload e crop sem e com Nitro). `TestCropAnimatedGIFProfileImage` e `TestProfileBioPronounsBannerAndAnimatedAvatar` passaram a conceder Nitro antes de subir GIF; `TestAdminEveryRouteIsGuarded` cobre as rotas novas.
- **Limitações.** O webhook do LiveKit não traz a taxa de quadros: os 30/60 fps só são limitados pelo cliente; a altura é a declarada pelo cliente ao publicar (melhor esforço, nunca derruba a chamada). O reenvio de um arquivo na mesma chave do avatar dentro dos 5 min da URL de PUT escapa da conferência por bytes (a exibição estática por plano no cliente cobre). Banidos, auditoria e a prévia da citação não levam `plan`.
- **Não verificado aqui.** Silenciamento real no LiveKit (só fake e twirp simulado), o hash com `SPOOK_SECRET_KEY` de produção, e tudo da interface (ainda não existe).

## Nitro e Nitro+: admin visual (09/11/2026)

Task 3 do plano `docs/superpowers/plans/2026-11-09-nitro.md` (parte do admin; o E2E fica para a verificação final). Nova tela `/admin/nitro` (`apps/web/src/pages/admin/nitro.tsx`) com item "Nitro" no menu: aba Concessões (buscar usuário, conceder com 7/30/90/365 dias, permanente ou dias personalizados, tabela com filtros, origem, vencimento relativo e absoluto, revogar com confirmação, paginação) e aba Códigos (gerar com plano, dias, quantidade e validade; texto exibido uma única vez com "Copiar todos"; lista com filtros mostrando só o final). `DataTable` ganhou a opção `hideSearch`. Testes: `apps/web/src/admin-nitro.test.tsx` (Vitest + MSW, 20 testes: conceder, permanente, validação, revogar, filtros, paginação, copiar, erros 403/404/422). Coluna de plano na lista de usuários: não feita, porque `GET /api/admin/users` não devolve `plan` (ponto de extensão registrado no SPEC 5.5). Não verificado: layout real em 390 px no navegador e o fluxo ponta a ponta contra o backend.

## Nitro e Nitro+: cliente web e desktop (09/11/2026)

Task 2 do plano `docs/superpowers/plans/2026-11-09-nitro.md`: a interface sobre o núcleo do backend. Decisões em `SPEC.md` 5.5 ("Adicional: Nitro e Nitro+", bloco do cliente) e visuais em `docs/design/DESIGN-SYSTEM.md`.

- **Feito.** `features/nitro` (matriz espelhada com teste de contrato contra `plans.json`, `usePlan`, `NitroBadge`, `Locked`, diálogo "Requer Nitro", seção Nitro); seção "Nitro" em Configurações (plano atual, validade e origem, tabela Grátis/Nitro/Nitro+, resgate com erros claros para 404/409/410/429, aviso nos últimos 7 dias, botão de assinar escondido até o pagamento existir); tela por plano (opções acima do limite com cadeado e "Requer Nitro", preferência salva reduzida, motor e desktop nativo limitados pelos `limits` do token de voz com fallback no plano); selos (cartão de perfil, membros, autor da mensagem, conectados, tile); cache (`ENTITLEMENT_UPDATE`, `USER_UPDATE.plan` sobrescrevendo, plano buscado ao conectar); GIF de dono sem plano **parado para todos** (avatar e banner, inclusive o banner do cartão, via canvas); upload de GIF/animado sem plano vira o diálogo "Requer Nitro" (antes do recorte e no 403 `nitro_required`); i18n pt-BR/en (catálogo `nitro.ts`).
- **Decisão do dono aplicada.** A animação depende do plano do **dono** da imagem (`plan` da pessoa exibida), não de quem vê; quem tem Nitro mantém as regras de antes.
- **Testes.** Vitest dos arquivos tocados e relacionados (nitro, diálogo de tela, qualidade, controlador de voz, engine nativa, avatar/banner, cache-bindings, conta, configurações, i18n e as suítes de voz, desktop, social, DMs, mensagens, convites e membros); `tsc --noEmit` e Biome na raiz limpos; builds web e desktop (saída fora do repo). Não rodei a suíte inteira, o E2E nem o Go (CI).
- **Limitações.** O limite de tela é do cliente + melhor esforço do servidor (altura no webhook). Selo ainda não aparece no cabeçalho de DM, na citação de resposta e no painel do usuário. A tela do /admin (concessões e códigos) é a Task 3. Pagamento (Task 4) não existe: o botão de assinar fica escondido.
- **Não verificado aqui.** Navegador e WebView do Tauri com o fluxo real (conceder pelo /admin e ver selo, cadeado, GIF parado/animado), compartilhamento de tela no LiveKit real com os três planos, e leitor de tela nas opções com cadeado.

## Nitro e Nitro+: pagamento com Mercado Pago (09/11/2026)

Task 4 do plano `docs/superpowers/plans/2026-11-09-nitro.md`. Decisões completas no SPEC (5.5, bloco "Pagamento"; RF31.6; seção 6 `orders`/`payments`; migration `00020_payments`).

- **Feito.** Pacote `server/internal/billing` (handler -> service -> store; interface `Gateway` definida pelo consumidor e cliente HTTP do Mercado Pago com timeout de 10 s, sem token em log nem erro): `GET /api/billing/config`, `POST /api/billing/checkout` (Checkout Pro, 30 dias, `external_reference` = pedido, `notification_url` e `back_urls` a partir de `PUBLIC_URL`) e `POST /api/billing/webhook` (assinatura `x-signature` HMAC-SHA256; nunca confia no corpo: busca o pagamento na API, confere `approved`, pedido pendente, valor e moeda; idempotente por `mp_payment_id` UNIQUE; concede com `source=payment` somando dias; estorno/chargeback revoga a concessão daquele pagamento). Rate limit `billing.checkout` (10/h por usuário). Config `MERCADOPAGO_ACCESS_TOKEN`, `MERCADOPAGO_WEBHOOK_SECRET`, `NITRO_PRICE_CENTS`, `NITRO_PLUS_PRICE_CENTS` em `config.go`, `.env.example`, `docker-compose.prod.yml`, `deploy.yml` (write-env com aspas simples) e `deploy/README.md`. Cliente: `useBilling`, botões "Assinar" com preço em BRL só quando habilitado, retorno `?payment=` com consulta curta do plano. `entitlement.Service` ganhou `GrantPayment` e `RevokePayment`.
- **Desligado por padrão.** Sem token: `{enabled:false}`, checkout 503, webhook nem registrado, botão escondido. Produção hoje não tem credenciais, então nada muda para o usuário.
- **Testes.** Go unitário com Mercado Pago falso (httptest), configuração, e integração em banco novo (`app/billing_integration_test.go`). Vitest dos arquivos de Nitro e i18n.
- **Limitações.** Pagamento único, sem recorrência nem nota fiscal. Se o `COMMIT` do pedido falhar depois de a concessão já gravada, a reentrega pode conceder 30 dias a mais (concessão e pedido são transações separadas; raro). A assinatura segue a documentação oficial atual do Mercado Pago (manifest com `id` da query, `request-id` e `ts`); os campos exatos da API (`init_point`, `transaction_amount`, `currency_id`, `external_reference`) foram implementados de acordo com a documentação e **não** foram exercitados contra o Mercado Pago real.
- **Não verificado aqui.** Qualquer chamada real ao Mercado Pago (sem credenciais), o redirecionamento do navegador pelo Checkout Pro, o `auto_return` em https e a entrega real do webhook. Passo a passo para o dono: `PENDENCIAS-DONO.md` E1.

## Nitro+: concessão em massa e lotes (10/11/2026)

Pedido do dono: "até eu ter tempo pra ajustar o Mercado Pago, libera 1 mês de Nitro+ pra todos os usuários". Sem escrever no banco de produção à mão: ação de admin segura e repetível. Decisões completas no SPEC (5.5, bloco "Concessão em massa e lotes"; seção 6 `entitlement_batches`; migration `00021_entitlement_batches`).

- **Feito.** `POST /api/admin/entitlements/grant-all {tier, days 1..3650, confirm: true}` (uma concessão por conta ativa, `source='admin'`, `granted_by` = o admin, em páginas de 500 por transação com `INSERT ... SELECT`), `GET /api/admin/entitlement-batches` (lotes e `eligible_users`) e `DELETE /api/admin/entitlement-batches/{id}` (revoga o lote). Aba "Em massa" em `/admin/nitro` com diálogo que mostra quantas contas serão afetadas e exige digitar `CONCEDER`, resumo de sucesso e lista de lotes com "Revogar lote" (confirmação digitada).
- **Decisões.** Filtro: `deleted_at IS NULL` (não há banimento global no modelo). Soma de validade igual à do serviço (do fim da validade mais longa do mesmo plano ou maior); quem tem o mesmo plano ou maior **permanente** é pulado. Idempotência: mesmo plano e prazo em lote não revogado há menos de 24 h devolve o lote (`already_applied`), sob trava consultiva; revogar o lote libera repetir. Avisos (`ENTITLEMENT_UPDATE` e `USER_UPDATE`) em segundo plano, 200 por segundo. Limites 3/h (conceder) e 10/h (revogar) por admin.
- **Testes.** Go unitário (`entitlement/batch_test.go`: confirm, soma, pulados, excluídos, idempotência e janela, revogar, falha no meio desfaz o lote, lista) e integração em banco novo (`app/bulk_grant_integration_test.go`: 401/403, validações 422, ponta a ponta com avisos ao vivo e `USER_UPDATE` para colegas, pedidos simultâneos geram um lote, mais de uma página de 500, rate limit 429). Vitest e MSW em `admin-nitro.test.tsx` (aba Em massa).
- **Como o dono usa.** Em `/admin/nitro`, aba "Em massa": Nitro+ 30 dias é o padrão; "Conceder a todos...", conferir o número, digitar `CONCEDER`. Se errar, "Revogar lote". Quem tinha Nitro+ por 10 dias passa a 40; quem tinha só Nitro ganha 30 dias de Nitro+ a partir de agora (o Nitro volta a valer depois).
- **Limitações.** Revogar o lote não desfaz dias que a pessoa tenha somado depois por cima da concessão do lote (um resgate posterior). Os avisos em tempo real saem em segundo plano e são interrompidos se o servidor desligar no meio (o plano já está gravado e aparece na próxima leitura). Concessão vale para as contas existentes na hora do pedido; contas criadas depois não recebem.
- **Não verificado aqui.** Produção e navegador reais (o roteiro está em `VALIDACAO-MANUAL.md`), a vazão dos avisos com muitos milhares de conectados, e o `goose down` da migration.

## Nitro+: período de cortesia de conta nova (10/11/2026)

Pedido do dono: "quando o usuário criar uma conta nova, pode dar Nitro+ por 14 dias, não precisa ser só pelo botão em massa". Decisões completas no SPEC 5.5 (bloco "Período de cortesia de conta nova").

- **Feito.** Toda conta nova (cadastro com senha e login social, no passo de escolher o username) ganha uma concessão `source='trial'` de Nitro+ por 14 dias, antes de a sessão abrir (a pessoa já vê o plano). Entrar em conta existente não concede. `NITRO_TRIAL_DAYS` (padrão 14, 0 desliga) e `NITRO_TRIAL_TIER` (padrão `nitro_plus`) por env, recusando valor inválido no boot; compose, `.env.example`, `deploy/README.md` e `write-env` do deploy (Variables, aspas simples) atualizados. Migration `00022_entitlement_trial` (CHECK de `source` + índice único parcial: uma cortesia por pessoa para sempre). Front: origem "Período de cortesia" na seção Nitro e no `/admin/nitro`, e faixa dispensável de boas-vindas com os dias reais, uma vez por pessoa e navegador.
- **Decisões.** O gancho fica em `auth.Register` e `social.Complete` (sem importar o store de `entitlement`), roda antes da resposta e falha sem derrubar o cadastro (log e `spook.entitlement.trial_failed`). Os padrões 14/`nitro_plus` só valem em `config.Load()`: o `Config` montado à mão nos testes tem 0 dia (desligado), e o E2E do CI define `NITRO_TRIAL_DAYS: "0"` para as contas continuarem no Grátis (bloqueio de GIF e de tela).
- **Soma.** Concessão independente: resgate, pagamento, admin e lote somam por cima (14 + 30 = 44; + lote de 30 = 74); o efetivo é o maior. O aviso de vencimento existente cobre a cortesia.
- **Limitações.** Não é a mesma transação do cadastro (usuário e concessão são gravados em sequência); se a concessão falhar a pessoa fica no Grátis até alguém conceder à mão. Contas anteriores ao recurso não ganham (use a concessão em massa). Ligar `NITRO_TRIAL_DAYS` em produção abre espaço para contas descartáveis ganharem Nitro+; o limite de cadastro por IP é o único freio.
- **Não verificado aqui.** Produção e navegador reais (roteiro em `VALIDACAO-MANUAL.md`), E2E Playwright (não rodado por limite de recursos), login social com Google/Discord de verdade (só com provedor falso).

## Áudio por aplicativo no compartilhamento de tela (11/11/2026)

Pedido do dono: escolher qual faixa de áudio compartilhar, como no TeamSpeak, numa seção separada "Configurações avançadas". Decisões completas no SPEC 5.5 (bloco "Adicional: áudio por aplicativo no compartilhamento de tela").

- **Achado.** O desktop nunca captou áudio ao compartilhar a tela (o `scap` só tem vídeo e o pedido de áudio era ignorado). Esta entrega cria a captura e a publicação do áudio da tela, e já com escolha por aplicativo. Só no **Windows 10 2004+/11** (WASAPI *process loopback*); macOS e Linux seguem sem áudio (o `scap` 0.0.8 não expõe áudio e o ScreenCaptureKit por aplicativo exigiria outro binding).
- **Feito.** Rust: `voice/appaudio.rs` (lógica pura testada: volume, agrupamento, árvore de processos, decisão de recuo, fila, mixagem com ganho individual x master, limitador), `voice/winaudio.rs` (sessões de áudio, captura por processo, supervisora de abrir/fechar, misturadora), `voice/screen_audio.rs`, `core.rs` (faixa `ScreenshareAudio`), comando `voice_list_audio_apps` e o parâmetro `audioApps` (retrocompatível). Web: seção "Configurações avançadas" fechada por padrão (interruptor, modo "Todo o sistema" ou "Aplicativos selecionados", volume master, lista com caixa e volume por aplicativo, atualização a cada 3 s e botão), persistência por executável, aviso de versão/plataforma, pt-BR/en. Na web (navegador) a seção não aparece.
- **Decisões.** "Todo o sistema" significa todo o sistema MENOS o Spook (sem eco da chamada); o Spook e o WebView2 dele nunca entram nem aparecem. Piso do Windows: build 19041 (a documentação cita 20348, mas a API existe desde a 2004). `windows` 0.58.0 (a mesma versão que o `scap` já traz) como dependência direta, sem versão nova no `Cargo.lock`. Volume 0 a 100 -> ganho quadrático. Sem ícone por enquanto.
- **Limitações.** Volumes não mudam com a transmissão em andamento; falha de captura em runtime só aparece no log (a tela segue só com imagem); estéreo de ponta a ponta não é garantido; sem ícones de aplicativo.
- **Verificado aqui.** `cargo test` real de `appaudio.rs` (16 testes) e `rustfmt --check` dos .rs alterados; `cargo check --target x86_64-pc-windows-msvc` do `winaudio.rs` numa crate descartável; `cargo metadata --locked` do app; Vitest dos arquivos tocados, `tsc`, Biome na raiz e `vite build --mode desktop`.
- **Não verificado aqui.** Todo o Rust com tauri/windows em execução (`core.rs`, `commands.rs`, `lib.rs` só compilam no workflow Desktop do CI), a captura real de áudio e a largura de 390 px renderizada. Roteiro no `VALIDACAO-MANUAL.md` (Spotify + navegador + jogo, volumes, o Spook não entra, apps que abrem/fecham).

## Supressão de ruído DeepFilterNet: nível "Máximo" (12/11/2026)

Pedido do dono: usar o DeepFilterNet (IA de código aberto) no app como alternativa melhor ao RNNoise, já que o Krisp só se licencia por contrato. Decisões completas e números no SPEC 5.5 (bloco "Adicional: supressão de ruído DeepFilterNet").

- **Feito.** Quarto nível de ruído, "Máximo (IA)", só no desktop: DeepFilterNet3 por `tract` (Rust puro, sem Python), modelo ONNX de ~8 MB embutido no binário, em `voice/deepfilter.rs`. Carrega em segundo plano (o RNNoise cobre até ficar pronto); proteção de CPU: se a média passar de 70% do orçamento de 10 ms por 1 s, ou de 100% por 0,2 s, volta sozinho para o Forte, registra no log e avisa a interface (toast discreto, uma vez por sessão). O "Forte" continua sendo o RNNoise.
- **Licença.** Código e pesos do modelo: MIT OR Apache-2.0 (README oficial). 54 crates novas no `Cargo.lock`, todas aditivas e permissivas.
- **Custo.** Binário +13,8 MB (instalador +9 a +11 MB), +33 MB de RAM com o nível ligado, ~2 a 4% de um núcleo do contêiner de teste, +20 a 30 ms de atraso no áudio publicado. Feature `deepfilter` do Cargo (ligada por padrão) isola tudo.
- **Verificado aqui.** `cargo test` real (lógica pura, `apm.rs` com `libwebrtc` de mentira, modelo real num teste `#[ignore]`), `rustfmt --check`, Vitest dos arquivos tocados, `tsc`, Biome, `vite build --mode desktop`.
- **Não verificado aqui.** Compilação do `tract` no Windows/macOS e do Rust com tauri/livekit (`core.rs`, `commands.rs`, `events.rs`, `lib.rs`); desempenho e qualidade reais com voz humana no hardware do dono (os números são de PCM sintético num contêiner Linux). A dependência vem de um repositório git (tag `v0.5.6`, commit fixado no `Cargo.lock`) porque o crates.io só tem a versão antiga do DeepFilterNet2.
- **Decisão que merece seu olho.** Ao cair, voltamos para o Forte (não para o Padrão): o RNNoise já está no mesmo caminho e custa ~0,7% de CPU. Se o `tract` não compilar no Windows do CI, desligar a feature `deepfilter` no `Cargo.toml` mantém o app inteiro funcionando (o "Máximo" cai para o Forte com o aviso "não disponível nesta versão").
