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

## Fase 5 — Voz, vídeo e tela

## Fase 6 — Uploads e notificações

## Fase 7 — Desktop

## Pendências gerais de configuração
