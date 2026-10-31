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
