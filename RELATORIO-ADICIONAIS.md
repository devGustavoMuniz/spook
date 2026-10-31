# Relatório dos adicionais (fora do SPEC)

Tudo aqui foi pedido **depois** do checkpoint `checkpoint-spec-completo` (commit `e39b794`, 31/10/2026). A lista bruta sai de
`git log checkpoint-spec-completo..HEAD`. Este arquivo é atualizado a cada adicional e vira o relatório final.

## 1. Supressão de ruído e cancelamento de eco melhores (qualidade de vida)

**Pedido:** "ligar, desligar ou melhorar a supressão de ruído, como o Krisp do Discord, com a melhor alternativa gratuita; cancelamento de
eco para não ouvir a própria voz, ao mostrar a tela ou vazando na call".

**Pesquisa:** o Krisp do LiveKit só existe no LiveKit Cloud pago. As alternativas livres são o RNNoise (BSD-3) e o DeepFilterNet3 (MIT/Apache-2.0).

| Parte | Estado |
| --- | --- |
| Web: 3 níveis de ruído (Desligada, Padrão do navegador, Forte com RNNoise), eco e ganho com interruptores, diálogo de compartilhar tela | Feito |
| Web: DeepFilterNet3 em vez de RNNoise | Não usado: o pacote comunitário depende de CDN de terceiros (403) e não traz WASM/modelo; custo de CPU maior |
| Desktop: nível Forte (RNNoise nativo) e atraso do eco medido em vez de fixo | Em andamento |

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
