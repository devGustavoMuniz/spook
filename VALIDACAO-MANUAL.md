# Validação manual

Itens que só o dono consegue validar (outra pessoa, outro dispositivo, permissões do navegador, instalação de app etc.).
Cada fase acrescenta os seus passos aqui, em ordem curta. Marque `[x]` conforme for validando.

> Produção: https://spook.dottadigital.com. Use contas de teste. Para cada fase, o deploy automático já foi feito quando a fase foi fechada.

## Fase 2 — Servidores, canais e mensagens

- [ ] Depois do deploy, os logs do container do Spook mostram a migration `00003` aplicada sem erro (tabelas `guilds`, `roles`, `channels`, `messages`, `invites`…).
- [ ] Quando o front existir: o upload do ícone do servidor (`POST /api/guilds/{id}/icon` e depois `PUT` na URL devolvida) funciona do navegador em produção (é o mesmo bucket/CORS do avatar).
- [ ] Fase B: para medir o histórico com volume, crie um servidor e um canal de **teste** em produção, popule com `bench/scripts/seed-messages.sql` (passos no cabeçalho do arquivo) e rode `bench/scenarios/messages.js` com o cookie de uma conta descartável; apague as mensagens depois (o `DELETE` está no arquivo).
- [ ] Front: conferir o visual de servidores, canais, mensagens, membros e diálogos (configurações, cargos, convites) nos temas **claro e escuro** e em tela estreita (a lista de membros some abaixo de `lg`; a barra de canais não recolhe em celular).
- [ ] Front: com `pnpm dev`, abrir um canal com `?perf=10000` (ex.: `/channels/<servidor>/<canal>?perf=10000`) e rolar a lista pelo mouse/trackpad; deve ficar fluida (alvo 60 fps). Se travar, abrir o Performance do DevTools e registrar o resultado na Fase B.
- [ ] Front: criar um servidor, trocar o ícone (PNG/JPEG/WebP até 5 MB) e conferir que ele aparece na barra de servidores (depende de S3/CORS em produção).
- [ ] Front: entrar por um link de convite (`/invite/<código>`) com uma segunda conta num navegador/dispositivo diferente, inclusive saindo da conta no meio (deve voltar ao convite depois do login).

## Fase 3 — Gateway realtime

- [ ] Depois do deploy: abrir o app em **dois navegadores/dispositivos** com contas diferentes no mesmo servidor e conferir que a mensagem enviada por um aparece no outro **sem recarregar**; atrás do Cloudflare, deixar a aba ociosa por mais de 2 minutos e conferir que a conexão **não cai** (o heartbeat de 41 s evita o corte de 100 s do Cloudflare).
- [ ] Atrás do Cloudflare Tunnel: o upgrade para WebSocket em `wss://spook.dottadigital.com/api/gateway` funciona (DevTools > Network > WS mostra HELLO e READY). Se o Cloudflare recusar o upgrade, conferir se **WebSockets** está ligado em Network no painel da zona (vem ligado por padrão).
- [ ] Resume na prática: com a aba aberta, desligar o Wi-Fi por ~20 s e religar; as mensagens enviadas nesse intervalo devem aparecer sozinhas (sessão sobrevive 60 s). Passando de 60 s o cliente refaz o IDENTIFY e recarrega os dados.
- [ ] Permissão: com uma segunda conta, tirar o cargo que dá `VIEW_CHANNEL` dela (ou tirar a permissão do `@everyone`) e conferir que ela para de receber mensagens do canal na hora.
- [ ] Desktop (Fase 7): o Tauri não manda headers no WebSocket; usar `POST /api/gateway/ticket` e conectar com `?ticket=`. A origem do webview (`tauri://localhost` no macOS/Linux, `http://tauri.localhost` no Windows) já é aceita por padrão; se o app usar outra origem, defina `SPOOK_ALLOWED_ORIGINS` no `.env` do VPS.
- [ ] Observabilidade em produção: `SPOOK_OTLP_ENDPOINT` segue vazio (métricas e traces do gateway ficam no-op). Para a Fase B, decidir onde roda o coletor OTLP (ver `deploy/README.md`, seção 8); em dev as métricas saem em `http://localhost:8889/metrics` (coletor, formato Prometheus).
- [ ] Fase B: rodar `bench/scenarios/gateway-connections.js` e `gateway-latency.js` (passos e cuidados em `bench/README.md`, Fase 3) com contas/canal de **teste**, medindo conexões por GB de RAM com `docker stats`. Combinar a carga antes: 10.000 conexões saturam o VPS de 2 vCPU.
- [ ] Ambiente Docker local sem espaço (`No space left on device` no Postgres derruba testes de integração): `docker builder prune` e `docker system df` liberam espaço.
- [ ] Front (tempo real) com contas reais: aba parada por 2+ min não cai (o heartbeat de 41 s mantém a conexão atrás do Cloudflare); ao voltar à aba nada pisca nem recarrega.
- [ ] Front: desligar o Wi-Fi por ~20 s com o canal aberto e religar; "Reconectando…" aparece só depois de ~2,5 s fora e some sozinho, e as mensagens enviadas por outra pessoa nesse intervalo surgem sem recarregar (resume). Fora por mais de 60 s: ao voltar, a lista de servidores e o histórico são recarregados sozinhos.
- [ ] Front: a mesma conta aberta em duas abas/dispositivos recebe os eventos nas duas (sessões independentes); quando uma sessão é retomada por outra conexão (4002) aparece "Sessão aberta em outro lugar" e o botão "Reconectar" funciona.
- [ ] Front: com duas contas reais, tirar o cargo que dá VIEW_CHANNEL (ou a permissão do `@everyone`) da segunda e conferir que ela é levada para fora do canal com o aviso e deixa de receber mensagens; devolver a permissão e conferir que o canal volta sem recarregar.
- [ ] Front: ser expulso de um servidor (ou ele ser excluído) com ele aberto leva ao início com o aviso "Você não está mais em …".
- [ ] Front: minimizar o navegador/trocar de aba por alguns segundos e voltar reconecta na hora se a conexão tiver caído (sem esperar o backoff).

## Fase 4 — Presença e DMs

- [ ] Depois do deploy, com duas contas reais num servidor em comum (dois navegadores): ao conectar uma, a outra a vê **online** na hora; fechar a aba e conferir que o **offline** só aparece depois de ~15 s (e que recarregar a página dentro desse prazo não faz a bolinha piscar). Com a mesma conta em duas abas, fechar só uma não muda o status.
- [ ] Ausente na prática (depende do front): deixar uma conta sem mexer o mouse/teclado por **10 minutos** (o cliente é quem mede e manda o op 12 `idle`) e conferir que a outra conta a vê "ausente"; mexer de novo volta a "online".
- [ ] "Digitando…" com duas contas: o indicador aparece na outra conta ao digitar, some ~8 s depois de parar (o fim é do cliente) e não aparece para quem não vê o canal.
- [ ] DM 1:1: abrir uma DM com alguém que compartilha servidor (aparece na lista da outra pessoa sem recarregar), trocar mensagens em tempo real, editar e excluir só a própria; tentar abrir DM com quem não compartilha servidor (deve recusar).
- [ ] DM em grupo com 3+ contas: criar, renomear (só o dono), adicionar e remover participantes (só o dono), sair como participante e conferir que quem saiu **para de receber** as mensagens; o dono não consegue sair nem ser removido.
- [ ] Atrás do Cloudflare, abrir 2 sessões da mesma conta e conferir que o status só vira offline quando as duas fecham.
- [ ] Observabilidade: com `SPOOK_OTLP_ENDPOINT` definido (Fase B), conferir as métricas `spook.presence.users`, `spook.presence.transitions`, `spook.typing.started` e `spook.dm.created` no coletor.
- [ ] Fase B: rodar `bench/scenarios/gateway-fanout.js` (passos em `bench/README.md`) com contas/canal de **teste** para registrar CPU e mensagens/s com N usuários conectados; combinar a carga antes (o k6 divide a CPU com o app na medição interna).

- [ ] Front (ausente): com a aba aberta, deixar a conta **10 minutos sem mexer** (mouse, teclado, toque) e conferir na outra conta que a bolinha vira âmbar ("Ausente"); mexer o mouse e conferir que volta a verde. Trocar de aba por 10+ min e voltar também conta como interação ao voltar. (O E2E só prova isso com relógio falso.)
- [ ] Front (ausente + reconexão): deixar a conta ausente, desligar o Wi-Fi por ~20 s e religar; a outra conta continua vendo "Ausente" (o estado é reenviado depois do resume ou do novo READY), não "Online".
- [ ] Front (DM em grupo com pessoas reais): criar um grupo com 3+ contas de verdade, com e sem nome, renomear, adicionar até 10 participantes, remover um (ele recebe o aviso e a conversa some da lista dele) e sair como participante; conferir o texto do erro ao tentar passar de 10 participantes e ao abrir DM com quem não divide servidor.
- [ ] Front (indicadores em claro e escuro): conferir a legibilidade das bolinhas online/ausente/offline sobre o avatar na lista de membros, na lista de DMs e no cabeçalho, nos dois temas, inclusive o contorno que separa a bolinha do avatar.
- [ ] Front ("digitando…"): com duas contas, o texto aparece embaixo do campo sem a lista pular, some ~8 s depois de parar e some na hora quando a pessoa envia; com 3 ou mais pessoas digitando mostra "Várias pessoas estão digitando…".
- [ ] Front (não lida na sessão): com a aba em outro servidor, receber uma DM e conferir a bolinha no botão Início e o negrito na conversa; abrir a conversa limpa. Recarregar a página zera a marcação (a contagem de verdade é a Fase 6).
- [ ] Front (E2E em produção): a tolerância de offline do E2E usa `SPOOK_PRESENCE_OFFLINE_GRACE=2s` só no backend de teste; **não** definir essa variável no `.env` do VPS (o padrão de 15 s é o do SPEC 7.6).

## Fase 5 — Voz, vídeo e tela

Backend (o front desta fase ainda não existe; os itens de interface entram quando ele for feito):

- [ ] Depois do deploy, conferir que `LIVEKIT_URL`, `LIVEKIT_API_KEY` e `LIVEKIT_API_SECRET` chegaram ao container `spook` (sem elas a voz responde 503) e que `deploy/livekit/livekit.prod.yaml` foi renderizado no servidor com `webhook.api_key` igual à `LIVEKIT_API_KEY` do `.env` (`grep -A3 '^webhook' /srv/spook/prod/deploy/livekit/livekit.prod.yaml`).
- [ ] **Webhook em produção:** com uma chamada em andamento, os logs do `livekit` devem mostrar `sent webhook ... "status": "200 OK"` para `http://spook:8090/api/livekit/webhook` (`docker compose ... logs livekit | grep webhook`). Qualquer `401` indica `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` diferentes entre o `spook` e o `livekit`; `connection refused`, o `spook` fora do ar. Os logs do `spook` não devem ter `voice: webhook falhou`.
- [ ] **Mídia direto pelo IP público:** de uma rede de fora do VPS, `nc -vz 187.127.26.46 7891` (TCP) e um teste de UDP em `187.127.26.46:7892` (a confirmação definitiva é uma chamada real conectar por UDP; no VPS `ss -ulnp | grep 7892`). Se o navegador conectar a sinalização (`wss://spook-rtc.dottadigital.com`) mas ficar sem áudio, o problema é 7891/tcp ou 7892/udp (firewall do VPS/provedor ou `LIVEKIT_NODE_IP`).
- [ ] **Teste real de voz com duas pessoas** (duas redes diferentes, dois navegadores): ambas entram no mesmo canal de voz, conversam, uma liga a câmera e compartilha a tela (com áudio do sistema onde a plataforma permitir) e a outra vê; mutar/silenciar reflete na outra conta; trocar de canal tira a pessoa do anterior para todo o servidor; DM 1:1 e em grupo também chamam.
- [ ] Permissões na prática: tirar CONNECT do cargo de alguém que está na chamada e conferir que ela é removida na hora e a lista de participantes atualiza para todos; tirar só VIDEO derruba câmera/tela mas mantém o áudio; tirar só SPEAK mantém a pessoa ouvindo, sem microfone.
- [ ] Reinício do LiveKit durante uma chamada (`docker compose ... restart livekit`): em até ~60 s os participantes fantasmas somem da lista (reconciliador); reiniciar o `spook` com a chamada ativa: em até ~60 s a lista volta a mostrar quem está na chamada.
- [ ] Observabilidade: com `SPOOK_OTLP_ENDPOINT` definido (Fase B), conferir `spook.voice.participants`, `spook.voice.tokens.issued/denied`, `spook.voice.webhooks` e `spook.voice.token.duration`.
- [ ] Fase B: rodar `bench/scenarios/voice-token.js` e `bench/scripts/livekit-load-test.sh` (passos em `bench/README.md`) com conta/canal de **teste**, combinando a carga antes; registrar CPU e banda por participante do LiveKit (teto de 0,5 CPU / 512M no VPS).

## Fase 6 — Uploads e notificações

## Fase 7 — Desktop

## Pendências gerais de configuração
