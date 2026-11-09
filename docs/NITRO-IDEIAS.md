# Ideias de recursos para Nitro e Nitro+ no Spook

Pesquisa e proposta, sem código. Consulta feita em 09/11/2026. Isto é material de decisão do dono; nada aqui entra no SPEC até ser escolhido.

## 0. Decisões já tomadas

| Plano | O que tem |
| --- | --- |
| Grátis | Tela em até 720p/30 fps; avatar e banner só estáticos |
| Nitro | Tela 1080p/60 fps; avatar e banner GIF/animados; selo |
| Nitro+ | Tudo do Nitro + tela em 1440p |

Obtenção: concessão do admin, códigos de resgate e, depois, Mercado Pago.

## 1. Fontes e confiabilidade

As páginas oficiais da central de ajuda (support.discord.com) bloquearam a leitura automática (HTTP 403). Os números abaixo vêm de resumos de busca dessas páginas, do blog oficial e de comparativos de terceiros. Onde há divergência, está marcado. **Confirme os números no próprio Discord antes de usá-los como argumento comercial**; para o Spook eles servem só de referência, não de obrigação.

- Blog oficial, retrospectiva de 2026: https://discord.com/blog/nitros-biggest-year-yet-a-look-back-at-2026 (upload dobrou de 500 MB para 1 GB; estilos de nome de exibição com fontes e efeitos; molduras de perfil; indicador de digitação personalizável; clipes em acesso antecipado; Nitro Rewards como programa de parceiros).
- Blog oficial, Nitro Basic: https://discord.com/blog/introducing-discord-nitro-basic (Basic = emoji personalizado em qualquer lugar e uploads maiores; Nitro completo acrescenta streaming HD; US$ 2,99/mês no lançamento).
- Central de ajuda, Server Boosting: https://support.discord.com/hc/en-us/articles/360028038352-Server-Boosting (e a FAQ de mesmo ID), lida só via resumo de busca.
- Central de ajuda, Nitro: https://support.discord.com/hc/en-us/articles/115000435108-Discord-Nitro e blog de personalização de perfil https://discord.com/blog/how-to-customize-your-discord-profile (decorações de avatar, efeitos de perfil, perfil por servidor, Server Tag via boosts).
- Comparativo de terceiro (menos confiável): https://www.unilink.us/blog/discord-nitro-features-2026 (Grátis 25 MB / Basic 50 MB / Nitro 500 MB, valores anteriores ao aumento para 1 GB).

## 2. (a) Como é no Discord

| Benefício | Grátis | Nitro Basic | Nitro | Server Boost (para todos do servidor) |
| --- | --- | --- | --- | --- |
| Upload por arquivo | ~10 a 25 MB (fontes divergem) | ~50 MB | 500 MB, o blog de 2026 diz 1 GB | Nível 2: 50 MB; nível 3: 100 MB |
| Mensagem | 2.000 caracteres | 2.000 | 4.000 (não confirmado na fonte oficial lida) | não |
| Emoji/figurinha de outros servidores, em qualquer lugar | não | sim | sim | não |
| Emoji animado | não | sim | sim | não |
| Slots de emoji do servidor | 50 | 50 | 50 | 100 / 150 / 250 (níveis 1/2/3) |
| Figurinhas do servidor | 5 | 5 | 5 | 15 / 30 / 60 |
| Soundboard (slots do servidor) | poucos | poucos | sons de outros servidores | 24 / 36 / 60 |
| Avatar e banner animados | não | não | sim | não |
| Perfil por servidor (avatar, banner, bio) | não | não | sim | não |
| Decorações de avatar e efeitos de perfil | só as gratuitas/de Quest | não | sim, com desconto na Loja | não |
| Molduras de perfil e estilos de nome (fonte/efeito) | não | não | sim (acesso antecipado/desconto) | não |
| Temas de cor do app | não | não | sim | não |
| Tag de servidor (Server Tag) | pode usar se o servidor liberar | idem | idem | servidor libera com boosts |
| Streaming | 720p/30 | 720p/30 | até 4K/60 | Go Live 1080p/60 em nível alto |
| Vídeo/câmera HD | não | não | sim | não |
| Qualidade de áudio do canal de voz | 64 kbps | 64 | 64 | 128 / 256 / 384 kbps (níveis 1/2/3) |
| Banner e ícone animado do servidor | não | não | não | sim (níveis 2/3) |
| Link de convite personalizado | não | não | não | nível 3 |
| Boosts de servidor incluídos | não | não | 2 boosts + desconto em mais | é o próprio boost |
| Selo no perfil | não | selo Basic | selo Nitro | selo de booster |
| Extras | | | Nitro Rewards (parceiros), clipes (acesso antecipado), indicador de digitação personalizado | |

Observações: (1) soundboard e limites exatos de slots variam entre fontes de terceiros; os números por nível de boost (níveis 1/2/3 com 2/7/14 boosts) vêm do resumo da página oficial; (2) preço de referência do Basic nos EUA: US$ 2,99; o do Nitro cheio, citado por terceiros: US$ 9,99.

## 3. (b) O que o Spook já tem e pode virar privilégio

Lido do SPEC.md e do CLAUDE.md.

| Já existe | Limite atual | Vira privilégio como |
| --- | --- | --- |
| Upload de anexos (URL pré-assinada, `LIMIT_ATTACHMENT_MB`) | 25 MB por arquivo, 10 anexos por mensagem | limite maior por plano |
| Tipos permitidos de upload | lista fixa (png, jpeg, gif, webp, pdf, txt, zip, áudio, vídeo) | nada (segurança, não vender) |
| Mensagens | 2.000 caracteres (runas), `MaxContentRunes` em `server/internal/message/message.go` (4.000 só nos chamados) | limite maior por plano (ex.: 4.000 no Nitro) |
| Tela: seletores 720/1080/1440p e 15/30/60 fps (RF18) | já implementados para todos | travar por plano (decisão tomada) |
| Avatar animado (GIF/WebP preservados) e banner (RF23.6) | liberados | travar por plano (decisão tomada) |
| Status personalizado, expiração até 48 h (RF15.3) | texto 128, emoji 32 | expiração mais longa/sem limite, status por servidor |
| Fixar mensagens | 50 por canal | mais fixadas |
| Bio | 190 caracteres | bio maior |
| Servidores por usuário | 100 (`LIMIT_GUILDS_PER_USER`) | 200 para Nitro |
| Convites com código sorteado (8 caracteres) | sem personalização | link personalizado |
| Supressão de ruído "Forte" com RNNoise (RF17), no cliente | grátis | **sim, já existe**; manter grátis, é qualidade básica e roda no aparelho do usuário |
| Chamados (tickets, RF/feedback) | todos iguais | prioridade/etiqueta de plano |
| Cargos, permissões, auditoria, banimento | para todos | nunca vender |
| Design system e `packages/brand` | tokens de cor | temas/acentos extras |
| Painel `/admin`, rate limits nomeados | só admin | base para conceder planos e limites por plano |
| Voz hexagonal (`voice` com porta `Provider`/LiveKit) | bitrates fixos | teto de bitrate por plano |

## 4. (c) Ideias próprias

Escala de esforço: P (dias), M (uma a duas semanas), G (mais que isso ou infra nova). "Infra" = dependência técnica. Todas pressupõem uma peça comum, descrita na seção 4.0.

### 4.0 Base obrigatória: entitlements

Um módulo `entitlement` (backend) com `Plan(user)` e uma tabela de limites por plano (`free`, `nitro`, `nitro_plus`), lida pelos `service`s existentes (nunca pelo handler). Colunas sugeridas: `users.plan`, `users.plan_expires_at`, `plan_grants` (concessões do admin, códigos de resgate, depois pagamentos). O gateway publica `USER_UPDATE` quando o plano muda, e o cliente exibe o recurso travado com CTA. **Toda checagem é no backend**; o cliente só esconde. Esforço M, valor alto: sem isso, nada das ideias abaixo existe. Risco: esquecer uma checagem e dar o recurso de graça; mitigar com testes por limite e com os limites vindo de uma única tabela.

### 4.1 Lista das ideias

| # | Ideia | Plano | Esforço | Valor ao usuário | Dependência técnica / infra | Risco de abuso |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | **Upload maior** (ex.: 25 MB grátis, 100 MB Nitro, 250 MB Nitro+) | Nitro / Nitro+ | P | Alto (mandar vídeo/clipe sem compactar) | Limite por plano no `attachment`; o PUT pré-assinado já assina o tamanho. Custo de disco/banda no Garage; thumbnail só até 25 MB hoje (manter) | Disco do VPS enche; cota total por usuário e limpeza de órfãos |
| 2 | **Mensagens mais longas** (grátis 2.000; Nitro 4.000) | Nitro | P | Médio | Limite em `message.service` e no composer; índice/tamanho de linha sem problema | Spam de blocos grandes; manter rate limit |
| 3 | **Selo Nitro / Nitro+** no perfil, cartão e lista de membros | Nitro / Nitro+ | P | Médio (status social) | Campo derivado do plano exposto em `User`; ícone em `packages/brand` | Nenhum; não mostrar quando o plano expira |
| 4 | **Avatar e banner animados** (decidido) | Nitro | P | Alto | Hoje já preservados; só bloquear no upload/crop e **converter para estático** ao expirar (guardar o original) | Quem perde o plano: degradar sem apagar |
| 5 | **Tela 1080p/60 fps e 1440p** (decidido) | Nitro / Nitro+ | P | Alto | Seletores já existem (RF18); falta travar no cliente e no token do LiveKit (limites de publicação por plano) e a tabela de teto de bitrate | Cliente adulterado: o limite precisa estar no token/grants do servidor, não só na UI; custo de banda do LiveKit no VPS |
| 6 | **Cor de nome e gradiente** (sólida no Nitro, gradiente/animado no Nitro+) | Nitro / Nitro+ | M | Alto (identidade) | Campo no perfil; render na lista, mensagens, voz; precisa conviver com a cor de cargo (definir precedência) | Contraste ruim/ilegível; cores ofensivas não, mas validar contraste e limitar a paleta |
| 7 | **Molduras/decorações de avatar e efeitos de perfil** | Nitro (catálogo básico), Nitro+ (catálogo completo) | M a G | Alto | Catálogo versionado (imagens/animações no `packages/brand` ou storage), tabela `user_cosmetics`; arte é o maior custo | Direitos de arte; ficar só com arte própria |
| 8 | **Emojis personalizados** (servidor e globais) | Servidor para todos; **globais** em Nitro | G | Muito alto | **Não existe emoji personalizado no Spook**: exige tabela `guild_emojis`, upload, picker, `:nome:` no parser, render nas mensagens, reações (também ausentes). Globais = lookup entre servidores | Imagens ofensivas, moderação; limites de slots por servidor |
| 9 | **Figurinhas** | Nitro (usar em qualquer servidor) | G | Médio | Mesmo trabalho de 8 mais renderização de mensagens só-figurinha | Mesmo risco de 8 |
| 10 | **Soundboard** | Nitro (mais slots/duração), uso básico grátis | G | Alto em voz | Não existe. Upload de áudio curto, tocar via LiveKit (publicar faixa), permissões e rate limit | Barulho em massa, áudio protegido; limitar duração (5 s) e cooldown, permissão por canal |
| 11 | **Câmera em HD/1080p** | Nitro | P a M | Médio | O LiveKit já publica vídeo; falta preset por plano e teto de bitrate | Banda do VPS; limite por sala |
| 12 | **Áudio de maior qualidade em voz** (bitrate Opus maior, estéreo) | Nitro | M | Médio (música/streamers) | Parâmetros de publicação do áudio no cliente + grants; a porta `Provider` já isola o LiveKit | CPU/banda; não afeta quem não tem |
| 13 | **Gravação de chamada** (local, no cliente) | Nitro+ | G | Alto | Gravar tracks no desktop (Tauri) e salvar em arquivo local; **consentimento visível a todos** na sala; versão no servidor é G+ (egress do LiveKit, armazenamento) | Privacidade e legalidade: aviso obrigatório, sem gravar escondido; jamais grátis nem silencioso |
| 14 | **Tema e acentos exclusivos** (paleta extra, tema do app) | Nitro | M | Médio | Tokens de `packages/brand` e do design system já são variáveis CSS; falta seletor e persistência no perfil | A ficha PDF da marca prevalece; manter temas escuros/claros padrão grátis |
| 15 | **Perfil por servidor** (apelido já existe; avatar, banner, bio por servidor) | Nitro | M | Médio | Tabela `guild_member_profiles`, cartão de perfil resolve o contexto | Conteúdo ofensivo por servidor; moderadores do servidor podem remover |
| 16 | **Status personalizado melhorado** (expiração livre, vários status, emoji animado) | Nitro | P | Baixo/médio | Já tem expiração de até 48 h (RF15.3); estender o limite | Pouco |
| 17 | **Mais fixadas por canal** (50 grátis, 100 Nitro) | Nitro | P | Baixo | Constante hoje fixa no SPEC; torná-la `LIMIT_*` por plano | Pouco; é por canal, quem fixa é moderador. Atenção: o limite vale para o canal, não para o usuário; melhor **não** vender isto, pois quem decide é o canal |
| 18 | **Mais servidores** (100 grátis, 200 Nitro) | Nitro | P | Baixo/médio | `LIMIT_GUILDS_PER_USER` já existe e é checado sob lock | Pouco |
| 19 | **Mais canais/membros por servidor** (servidor "turbinado") | **Boost de servidor** (não do usuário), ver 4.2 | M | Médio | `LIMIT_*` por servidor, não por usuário | Complexidade econômica |
| 20 | **Link de convite personalizado** (`spook.../convite/meu-servidor`) | Nitro (dono do servidor) | M | Médio | Slug único, reservar nomes (colisão, marcas), roteamento; fácil de abusar para phishing/imitar marcas | Squatting e imitação; lista de reservados, revisão manual, perda ao expirar o plano |
| 21 | **Histórico de busca/mensagens maior** | Nitro+ | G | Médio | **Busca não existe** (Meilisearch está na Fase 9, fora de escopo). Não vender o que o produto não tem; só considerar após a busca existir | Custo de índice |
| 22 | **Prioridade no suporte (chamados)** | Nitro / Nitro+ | P | Médio | Etiqueta e ordenação na fila do admin (`tickets`); sem prometer SLA se você é uma pessoa só | Prometer prazo que não dá para cumprir |
| 23 | **Redução de ruído premium** | Manter **grátis** | - | - | RNNoise já está no cliente, custo zero para o servidor. Uma versão melhor (DeepFilterNet) foi descartada por licença/peso no SPEC; só revisitar se houver caso real | Vender algo que já é grátis gera revolta |
| 24 | **Clipes** (últimos 30 s da tela, salvos e postados no chat) | Nitro+ | G | Alto | Buffer circular no desktop (Tauri, Rust) + upload com o limite do plano | CPU; privacidade |
| 25 | **Estilo de nome de exibição** (fonte/efeito, como o Discord lançou em 2026) | Nitro+ | M | Médio | Fontes embutidas e CSS; ligado à ideia 6 | Fonte ilegível; limitar o catálogo |
| 26 | **Reações e emoji animado em reações** | Reações para todos; animadas Nitro | G | Alto | Reações **não existem** (fora do escopo hoje); só entram com o recurso base | Mesmo de 8 |
| 27 | **Indicador de digitação/ícone de presença personalizado** | Nitro+ | M | Baixo | Detalhe estético; só se sobrar tempo | Pouco |
| 28 | **Transferir plano / presente** (gift) | Nitro | M | Médio | Código de resgate já previsto; "presentear" = gerar código ligado ao comprador | Revenda de códigos, fraude de pagamento; ligar ao Mercado Pago só depois |
| 29 | **Período de teste e carência** | Nitro | P | Alto para conversão | `plan_expires_at` + job River que expira e faz o downgrade suave | Contas descartáveis para teste infinito; um teste por conta verificada por e-mail |
| 30 | **Cota de armazenamento por usuário** (soma dos anexos) | Nitro / Nitro+ | M | Médio | Contagem de bytes por usuário, limpeza; sustenta a ideia 1 sem estourar o VPS | Nenhum, é proteção |

### 4.2 Boost de servidor (opcional, ondas 3)

No Discord, grande parte da graça está no boost, que beneficia o servidor inteiro. No Spook, um `Nitro` poderia ceder 1 a 2 "boosts" por mês para aplicar a um servidor, que então ganha slots de emoji, upload maior para todos, banner animado, link personalizado e áudio melhor. Esforço G, só vale quando houver emoji, soundboard e servidores com vida própria. Risco: custos de infra que dependem de boosts de terceiros; tratar como Onda 3.

## 5. (d) Priorização em ondas

**Onda 1: barata e de alto valor** (tudo só depende de entitlements e de travar o que já existe)
1. 4.0 Entitlements + painel admin de concessão e códigos de resgate
2. 3. Selo Nitro / Nitro+ (decidido)
3. 4. Avatar e banner animados (decidido) + degradação ao expirar
4. 5. Tela 1080p/60 e 1440p com limites no token (decidido)
5. 1. Upload maior + 30. cota de armazenamento
6. 2. Mensagens mais longas
7. 18. Mais servidores
8. 22. Prioridade nos chamados
9. 29. Teste e carência (job de expiração)

**Onda 2: valor alto, esforço médio**
10. 6/25. Cor de nome, gradiente e estilo de nome
11. 7. Molduras de avatar e efeitos de perfil (catálogo curto, arte própria)
12. 14. Tema e acentos exclusivos
13. 15. Perfil por servidor
14. 11/12. Câmera HD e áudio de maior qualidade
15. 16. Status personalizado estendido
16. 28. Presente por código

**Onda 3: grande, depende de recursos que o Spook ainda não tem**
17. 8/9/26. Emoji, figurinhas e reações (base primeiro, privilégio depois)
18. 10. Soundboard
19. 13/24. Gravação de chamada e clipes (desktop)
20. 20. Link de convite personalizado
21. 4.2 Boost de servidor
22. 21. Busca e histórico maior (só após a Fase 9)

## 6. (e) Cuidados de produto

**Não quebrar o plano grátis.**
- Nada que já funciona para todos hoje deve ser removido sem aviso; quando um recurso passar a ser pago (avatar animado já existe e é grátis hoje), explicar a mudança, dar um período de graça e **não apagar** o conteúdo: guardar o original e exibir a versão estática (primeiro quadro do GIF) enquanto o plano estiver inativo.
- O grátis precisa continuar sendo um produto completo: conversar, voz, vídeo, tela 720p/30 fps, criar servidor, convidar, moderar.
- Ao expirar o plano: downgrade suave, sem perder mensagens, anexos já enviados, servidores além do limite (ficam, só não se cria novos) nem cargos.
- Mostrar o recurso travado com uma mensagem clara e um caminho para obter, sem pop-up insistente.
- Mensurar antes de limitar: cada limite novo por plano precisa de métrica (`spook.entitlement.denied{feature}`) para ver o que as pessoas tentam usar.

**Nunca deve ser pago (segurança e moderação).**
- Banir, expulsar, silenciar, cargos e permissões, registro de auditoria, filtros de conteúdo, denúncias.
- Autenticação forte: verificação de e-mail, troca/recuperação de senha, sessões ativas, bloquear usuários, não perturbar, controle de privacidade (quem pode me adicionar/enviar DM).
- Direitos sobre os próprios dados: exportar e excluir a conta; recebimento de notificações de segurança.
- Prioridade de suporte vale para conveniência, mas denúncias de abuso e segurança são tratadas igual para todos.
- Qualidade mínima de voz e supressão de ruído (RNNoise já é grátis; mantenha).

**Segurança e abuso.**
- Toda checagem de plano é no backend, inclusive no token do LiveKit (resolução e fps máximos).
- Conteúdo comprado ou enviado por assinantes (emoji, figurinhas, sons, links personalizados, moldura) passa pela mesma moderação; plano pago não é imunidade.
- Códigos de resgate: alta entropia, uso único, expiração, rate limit nomeado, registro de quem usou; admin consegue revogar.
- Mercado Pago (depois): webhook com assinatura verificada, idempotência por `payment_id`, reconciliação periódica, estorno/chargeback revoga o plano; tratar dados fiscais e a LGPD; nunca guardar cartão.
- Compartilhamento de conta ou revenda de códigos: aceitar como risco baixo no início; monitorar uso anormal.
- Custo: 1440p/60 fps e uploads grandes pesam banda e disco do VPS. Colocar limites globais configuráveis (`LIMIT_*`) e uma chave geral de desligar o benefício em emergência.

**Comunicação.** Texto de produto em pt-br; os nomes "Nitro" e "Nitro+" são marca do Discord ("Nitro"), vale pensar em um nome próprio antes de lançar publicamente, para evitar confusão ou problema de marca. Ainda que o Spook seja um projeto de estudo, o mesmo vale se virar público.

## 7. As 8 que eu faria primeiro

1. **Entitlements + concessão pelo admin + códigos de resgate** (4.0): sem isso nada existe; já cobre a decisão de obtenção.
2. **Tela 1080p/60 e 1440p travadas por plano** (5): decidido, o código de seletores já existe; falta o limite no servidor.
3. **Avatar e banner animados só no Nitro** (4), com degradação suave: decidido e barato.
4. **Selo Nitro / Nitro+** (3): visibilidade social, esforço mínimo.
5. **Upload maior + cota de armazenamento** (1 e 30): benefício que todos entendem, usa a infra existente.
6. **Mensagens mais longas** (2): quase de graça e perceptível.
7. **Cor de nome e estilo de nome** (6/25): o recurso de identidade mais desejado e relativamente simples.
8. **Teste gratuito e expiração suave com job River** (29): protege o plano grátis e viabiliza o futuro pagamento.

Os próximos candidatos, quando houver fôlego: molduras de avatar (7), tema/acentos (14), câmera HD (11) e prioridade nos chamados (22). Emoji personalizado (8) é o de maior valor, mas é um recurso novo inteiro; planejar como projeto próprio.
