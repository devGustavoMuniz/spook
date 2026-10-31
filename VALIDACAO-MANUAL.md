# Validação manual

Itens que só o dono consegue validar (outra pessoa, outro dispositivo, permissões do navegador, instalação de app etc.).
Cada fase acrescenta os seus passos aqui, em ordem curta. Marque `[x]` conforme for validando.

> Produção: https://spook.dottadigital.com. Use contas de teste. Para cada fase, o deploy automático já foi feito quando a fase foi fechada.

## Fase 2 — Servidores, canais e mensagens

- [ ] Depois do deploy, os logs do container do Spook mostram a migration `00003` aplicada sem erro (tabelas `guilds`, `roles`, `channels`, `messages`, `invites`…).
- [ ] Quando o front existir: o upload do ícone do servidor (`POST /api/guilds/{id}/icon` e depois `PUT` na URL devolvida) funciona do navegador em produção (é o mesmo bucket/CORS do avatar).
- [ ] Fase B: para medir o histórico com volume, crie um servidor e um canal de **teste** em produção, popule com `bench/scripts/seed-messages.sql` (passos no cabeçalho do arquivo) e rode `bench/scenarios/messages.js` com o cookie de uma conta descartável; apague as mensagens depois (o `DELETE` está no arquivo).

## Fase 3 — Gateway realtime

## Fase 4 — Presença e DMs

## Fase 5 — Voz, vídeo e tela

## Fase 6 — Uploads e notificações

## Fase 7 — Desktop

## Pendências gerais de configuração
