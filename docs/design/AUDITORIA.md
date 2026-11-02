# Auditoria visual do Spook (antes da repaginação)

Base: as capturas de `docs/design/antes/` (`NN-tela-tema-viewport.png`, 2 temas x 2 viewports, 168 imagens), geradas por `apps/web/design/capture.spec.ts` contra o build de produção servido pelo backend local, com mídia falsa do Chromium e LiveKit real. Os nomes abaixo omitem `-tema-viewport`: `09-canal-texto-mensagens` quer dizer `09-canal-texto-mensagens-{claro,escuro}-{1440,390}.png`. Onde o problema só aparece num tema ou viewport, o texto diz qual.

Telas que não deu para capturar (`antes/_falhas.txt`): lista de membros e resposta a mensagem no viewport de 390 px. O painel de membros não existe no celular (não há como abri-lo) e o botão "Responder" só aparece no hover, inacessível por toque. As duas lacunas são, por si, itens da lista abaixo (P0).

## Prioridades

- **P0**: quebra o uso ou a leitura. Corrigir nas etapas de tela.
- **P1**: faz o app parecer rascunho; corrigir junto da tela.
- **P2**: polimento.

## Problemas transversais

| Prio | Problema | Onde | Evidência |
| --- | --- | --- | --- |
| P0 | **Nenhuma tela do app é responsiva.** Em 390 px a barra de servidores (72 px) + a de canais (240 px) ocupam quase tudo e a conversa é espremida numa coluna de ~80 px, com o texto quebrando letra por letra. Sem menu "hambúrguer", sem painel de membros, sem voz utilizável. | todo o app autenticado | `09-canal-texto-mensagens-*-390`, `25-dm-conversa-*-390`, `39-voz-sozinho-*-390`, `40-voz-com-outras-pessoas-*-390` |
| P0 | Diálogos estouram a largura no celular: o conteúdo (lista de cargos, contagens, interruptores) é cortado à direita, sem rolagem horizontal nem layout em uma coluna. | cargos, configurações do servidor | `18-dialogo-cargos-*-390`, `19-dialogo-cargos-permissoes-*-390` |
| P0 | 404 e rotas inexistentes mostram o texto cru "Not Found" (inglês, sem layout, canto superior esquerdo, sem ação de volta). | roteador | `05-404-*`, `31-404-logado-*` |
| P1 | Sem escala de espaçamento/tipografia: tudo é `text-sm` com pesos parecidos; títulos de tela, de card e de diálogo quase não se distinguem do corpo. | todas | `27-perfil-*`, `28-notificacoes-*`, `20-dialogo-configuracoes-servidor-*` |
| P1 | Neutros "cinza puro" (#F7F7F7/#060606) sem relação com o roxo da marca; superfícies sem camadas (fundo, painel e cartão quase idênticos), sensação chapada. No escuro, bordas #222 somem. | todas | `09-canal-texto-mensagens-escuro-1440`, `28-notificacoes-escuro-1440` |
| P1 | Estados de hover/ativo/foco inconsistentes: botões de ícone da barra lateral e do rodapé sem fundo no hover, itens de canal com hover diferente de itens de menu, tooltips ausentes na maioria dos ícones. `cursor` nos botões era o padrão da seta (o preflight do Tailwind v4 zera `cursor: pointer`). | barras laterais, composer, painel de usuário | `12-mensagem-hover-*`, `30-menu-de-status-*` |
| P1 | Foco de teclado: anel `outline-ring` global funciona, mas campos não mudam de borda, o anel `#A58BE6` tem 2.8:1 sobre branco (mínimo 3:1), e há `outline-none` em itens de menu sem substituto no teclado. | campos, menus | `01-login-claro-1440` (campos), `16-menu-do-servidor-*` |
| P1 | Contraste: o roxo da marca `#7C5CC4` como texto (links, nomes de cargo) tem 5.0:1 sobre branco, mas cai para 4.3:1 sobre o realce `#F1ECFA`, 4.0:1 sobre o fundo escuro `#060606` e 3.3:1 sobre o realce escuro `#221B33`: abaixo de AA para texto pequeno. A cor de cargo (âmbar, roxo) vem do servidor e não é garantida. Borda de campo (`#E1E1E1` sobre branco) tem 1.3:1 (o mínimo para componentes é 3:1). | links, nomes de cargo, campos | `09-canal-texto-mensagens-*`, `01-login-claro-*` |
| P1 | Estados vazios sem ilustração nem ação: "Este é o início de #vazio" é só texto à esquerda. | canal vazio, DM vazia, listas | `08-canal-texto-vazio-*`, `24-dms-lista-*` |
| P1 | Avatar padrão é sempre a mini logo (mesmo ícone para todos): impossível distinguir pessoas numa lista, sem cor/iniciais. | mensagens, membros, voz | `09-canal-texto-mensagens-*`, `40-voz-com-outras-pessoas-*` |
| P2 | Sem animação de entrada/saída em diálogos, menus e toasts (aparecem de uma vez); sem skeletons ao carregar; `prefers-reduced-motion` não tratado. | todas | `16-menu-do-servidor-*`, `17-dialogo-convite-*` |
| P2 | Barras de rolagem nativas grossas no desktop; sem estilo fino. | listas | `13-composer-respondendo-*` |
| P2 | Cor de sucesso/aviso/erro improvisada com classes soltas (`emerald-500`, `amber-500`, `red-500`) em vez de tokens. | presença, voz, anexos | `11-lista-de-membros-*`, `39-voz-sozinho-*` |

## Por tela

### Entrada (`01`–`05`)
- `01-login`, `03-cadastro`: bloco centrado sobre fundo liso, sem profundidade (nenhum brilho/gradiente da marca); o cartão é a única hierarquia. Lettering e mascote um sobre o outro, mais frases com "·" frágeis no celular. Botão do tema solto no canto sem fundo/hover visível. (P1)
- `02-login-erro`: erro aparece como texto pequeno sob o formulário, sem ícone nem destaque. (P1)
- `04-convite-deslogado`: reaproveita o cartão do login sem contexto do servidor convidado (ícone, nome, membros). (P1)
- `05-404`: ver P0 acima.

### Início e criação (`06`, `07`, `22`)
- `06-home-sem-servidor`: o mascote está bem, mas o título, o texto e os dois botões ficam pequenos e soltos; a barra lateral à esquerda tem só ícones. (P1)
- `07-dialogo-criar-servidor`, `22-dialogo-adicionar-servidor`: abas segmentadas apertadas, campo sem ajuda, botões na esquerda; fecha com "x" minúsculo (16 px, sem hover). (P1)

### Canal de texto (`08`–`15`)
- `08-canal-texto-vazio`: ver estados vazios.
- `09-canal-texto-mensagens`: cabeçalhos de autor, hora e texto com o mesmo peso e tamanho; avatares pequenos e iguais; sem separador de dia legível no topo; anexo de imagem sem cantos arredondados definidos e sem legenda; cartão de arquivo com borda forte. Menção destacada com fundo cinza e barra lateral, mas sem rótulo. A separação "Novas mensagens" é uma linha vermelha fina (P1). Composer com o ícone de enviar desabilitado em lilás claro, quase sem contraste (P1). Contador "0/2000" solto no canto (P2).
- `10-canal-texto-topo-mensagens-antigas`: separadores de dia ("1 de novembro...") discretos demais; agrupamento de mensagens do mesmo autor sem espaço de respiro. (P2)
- `11-lista-de-membros`: título "MEMBROS — 3" em caixa alta pequena e cinza; cargo escrito embaixo do nome com cor própria do cargo (contraste baixo); bolinha de presença cinza no claro quase invisível. Não existe no celular (P0). (P1)
- `12-mensagem-hover`: a barra de ações aparece no hover sem fundo/sombra, sobrepondo o texto; só por hover (inacessível no toque). (P1)
- `13-composer-respondendo`: faixa "Respondendo a..." fina, sem separação do campo. (P2)
- `14-mensagens-fixadas`: painel lateral sem título forte, itens sem estados. (P1)
- `15-canal-texto-com-mencao`: o indicador de não lidas é um número vermelho minúsculo ao lado do canal; o canal com menção não se destaca. (P1)

### Menus e diálogos do servidor (`16`–`23`)
- `16-menu-do-servidor`: itens colados, ícones sem alinhamento com o texto de duas linhas ("Configurações de notificação" quebra), separadores finos. Sem atalhos nem animação. (P1)
- `17-dialogo-convite`: título repete o nome do servidor e o subtítulo vira "Configurações do servidor" mesmo para convites; linhas de convite com código em fonte monoespaçada pequena e dois botões de texto vermelhos/cinza lado a lado sem hierarquia. (P1)
- `18-dialogo-cargos`, `19-dialogo-cargos-permissoes`: dois painéis dentro de um diálogo com rolagem interna; seletor de cor é um quadrado sem rótulo ("Sem cor" solto ao lado); interruptores em lista longa sem agrupamento; no celular, estoura. (P0 no 390, P1 no 1440)
- `20-dialogo-configuracoes-servidor`, `21-dialogo-criar-canal`: formulários sem agrupamento, botões sem hierarquia entre primário e secundário. (P1)
- `23-menu-de-membro`: itens de ação sem ícone e sem destaque da ação destrutiva. (P2)

### DMs (`24`–`26`)
- `24-dms-lista`, `25-dm-conversa`: lista de conversas com avatar+nome apenas (sem prévia da última mensagem nem hora); estado selecionado e hover quase iguais; botão "Ligar" (outline) é o único destaque do cabeçalho. Conversa vazia sem ilustração. (P1)
- `26-dialogo-novo-grupo`: campo de busca e lista sem estados vazios claros. (P2)

### Perfil, configurações e notificações (`27`–`30`)
- `27-perfil`, `28-notificacoes`, `29-config-app`: cartões empilhados numa coluna estreita sem ícones, sem título de página; navegação superior é só texto (sem marcação de página atual); duplicação do tema/sair (barra lateral e cabeçalho). Descrições longas em cinza de baixo contraste. (P1)
- `30-menu-de-status`: itens sem prévia da cor do status. (P2)

### Erros (`31`–`34`)
- `31-404-logado`: ver P0. `32-erro-servidor-inexistente`: o aviso aparece como toast azul fino sobre o cabeçalho, que cobre o título do canal e some rápido. `33-convite-invalido`, `34-convite-ja-membro`: mensagens soltas no centro, sem ilustração nem botão claro de saída. (P1)

### Admin (`35`–`38`)
- Melhor tela do app (cartões, tabela, cabeçalhos ordenáveis), mas usa os mesmos neutros chapados; no celular os cartões ocupam a largura toda e a tabela exige rolagem horizontal sem indicação. Números do dashboard poderiam usar fonte tabular. (P2)

### Voz (`39`–`43`)
- `39-voz-sozinho`: **o palco de voz é uma lista de nomes** ("CONECTADOS (3)") sobre um fundo vazio, em vez de uma grade de tiles; o botão "Sair do canal" vermelho cheio no cabeçalho é o elemento mais forte da tela. (P0 para a etapa de voz)
- `40-voz-com-outras-pessoas`: o anel verde de fala é um contorno fino de 2 px no avatar de 36 px; sem destaque de quem fala; ícones de mudo/ouvindo em tamanho minúsculo à direita. (P1)
- `41-voz-com-camera`, `42-voz-tela-compartilhada`: vídeos em miniaturas de ~190 px abaixo de um palco preto; rótulos "Você · Câmera" em caixas pretas; lista de participantes continua embaixo. Sem barra de controles flutuante: os controles ficam num cartão minúsculo no rodapé da barra lateral (câmera, tela) e o microfone/fone no painel do usuário. (P0 para a etapa de voz)
- `43-dialogo-dispositivos-voz`: diálogo longo com medidores e controles sem agrupamento visual. (P2)

## Ordem sugerida para as próximas etapas

1. Layout responsivo do app (P0: barras, painéis, diálogos no celular).
2. Voz: grade de tiles, avatar central com cor derivada, anel de fala, barra flutuante.
3. Texto: mensagens, composer, menus e painel de membros.
4. Entrada, 404/erros e estados vazios (usar `components/illustrations`).
5. Diálogos de servidor/cargos, perfil e notificações; admin por último.
