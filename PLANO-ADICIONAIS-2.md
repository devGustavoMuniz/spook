# Plano: funcionalidades do Antrax que faltam no Spook

Origem: comparação feita em 01/11/2026 entre o Antrax (Laravel + Inertia/React) e o Spook, por leitura de código (nenhum dos dois apps foi executado). O dono escolheu o que entra; **nada aqui foi implementado**. Tudo é **adicional** ao SPEC (depois da tag `checkpoint-spec-completo`) e deve entrar no `RELATORIO-ADICIONAIS.md` quando for feito.

Legenda de esforço: **P** até 1 dia, **M** 2 a 4 dias, **G** 5 dias ou mais (estimativa, não medida). Os caminhos "no Antrax" servem de referência de comportamento: não copiar código nem marca.

## Escolhas do dono

| Área | Decisão |
|---|---|
| Contas | Todos, **menos 2FA e código de cadastro** |
| Social | Todos |
| Servidores | Todos |
| Mensagens | Todos |
| Voz | Todos, **menos soundboard** |
| Perfil | Todos |
| Desktop | Sim |
| Admin | Sim, **e melhorar os gráficos** (hoje a maioria é tabela) |

## Decisões que precisam do dono antes de começar

1. **Amizades mudam o SPEC 7.4.** Hoje DM abre com quem compartilha servidor. Com amizades, é preciso decidir: DM continua aberta a quem compartilha servidor, ou passa a exigir amizade (ou servidor em comum sem bloqueio)? Atualizar SPEC 7.4 no mesmo commit.
2. **E-mail exige SMTP.** Verificação de e-mail, recuperação de senha e troca de e-mail dependem de um provedor de envio (Resend, SES, SMTP do VPS...). Escolher o provedor e criar os secrets (`gh secret set`, sem exibir valores). Sem isso, recuperação de senha por e-mail fica bloqueada; o `spook admin` pode ganhar `reset-password` como solução provisória.
3. **Login social exige apps OAuth** (Google e Discord) com client id/secret e URLs de callback de produção e de dev. Segredos só por variáveis de ambiente.
4. **i18n (pt-BR/en)** está em SPEC 2.2 como fora de escopo e dobra o custo de todo texto novo. Está na lista por "Perfil → todos"; sugestão: fazer por último, quando a UI estiver estável.
5. **Plano mobile (Expo)** também veio no pacote "Desktop → Sim" do relatório. Está em SPEC 2.2 (Fase 8) e no Antrax é só planejamento. Sugestão: manter só como item opcional no fim, a confirmar.
6. **Permissões por canal** entram como adicional, mas mexem em `perm` e em toda leitura de mensagens/voz: exigem revisão de segurança dedicada (toda ação é autorizada no backend).

## Ordem sugerida (ondas)

As ondas respeitam dependências: moderação e permissões antes de auditoria; amizades antes de convidar amigo e de chamada em DM entre amigos.

- **Onda 1 – Fundações de conta e perfil:** trocar senha e e-mail (sem e-mail ainda: só senha), excluir conta, usernames reservados, apelido por servidor, bio/pronomes/banner/avatar animado, confirmar senha antes de ações sensíveis.
- **Onda 2 – Moderação e permissões:** banir/desbanir, permissões por canal, mutar/desconectar na voz, `@everyone` e menção a cargo, mensagem de sistema "fulano entrou", tópico de canal, excluir servidor com confirmação de senha, limites configuráveis, log de auditoria.
- **Onda 3 – Social:** amizades, bloqueio, presença de amigos, cartão de perfil, convidar amigo, chamada em DM com toque.
- **Onda 4 – Mensagens e voz:** autocomplete de `@`, cartão de convite inline, sons de evento, espectadores de transmissão, pré-visualização da tela, assistir/não assistir, layouts de chamada, trocar fonte da tela, tela cheia com controles ociosos, webhooks do LiveKit.
- **Onda 5 – E-mail e login social:** (depende das decisões 2 e 3) verificação de e-mail, recuperação de senha, login social, login do desktop por navegador.
- **Onda 6 – Desktop e admin:** auto-update, página de download, splash; admin com gráficos novos, histórico do LiveKit e capacidade.
- **Onda 7 – Opcionais:** i18n, aviso de nova versão, "removido do servidor", mobile.

---

## 1. Contas e segurança

Fora: 2FA TOTP e código de cadastro (decisão do dono).

| # | Funcionalidade | Referência no Antrax | Esforço | Notas para o Spook |
|---|---|---|---|---|
| 1.1 | Trocar senha logado | `SecurityController`, `PUT settings/password` | P | Exige senha atual; encerra as outras sessões; rate limit por ação. |
| 1.2 | Trocar e-mail | `ProfileUpdateRequest` | M | Depende de e-mail (decisão 2); confirmar no endereço novo antes de trocar. |
| 1.3 | Excluir conta | `DELETE settings/profile`, `delete-user.tsx` | P–M | Pede senha; **recusa dono de servidor** (transferir antes); cascata de dados, mensagens preservadas ou anonimizadas (decidir; registrar no SPEC); apagar arquivos no S3 por job River. |
| 1.4 | Verificação de e-mail | Fortify, `verify-email.tsx` | M | Decisão 2. Definir o que fica bloqueado antes de verificar (sugestão: convidar/criar servidor). |
| 1.5 | Recuperação de senha por e-mail | `forgot-password.tsx`, `reset-password.tsx` | M | Token de uso único com expiração curta; resposta idêntica exista ou não a conta; rate limit. |
| 1.6 | Login social (Google e Discord) + tela "escolher username" | `SocialAuthController`, `social_accounts`, `choose-username.tsx` | M | Decisão 3. Tabela `social_accounts`; vincular/desvincular em Configurações (nunca desvincular o último método de login). Hoje o SPEC 2.2 exclui: atualizar. |
| 1.7 | Confirmar senha antes de ações sensíveis | `confirm-password.tsx` | P | Janela curta (ex.: 10 min) após confirmar; aplicar a trocar senha/e-mail, excluir conta, excluir servidor. |
| 1.8 | Usernames reservados | `ReservedUsernames.php` | P | Lista no backend (admin, root, spook, suporte...); aplicada no cadastro e na troca de username. |
| 1.9 | Login do desktop por navegador (handoff com código de uso único) | `DesktopLoginController`, `desktop_login_codes` | M | Só faz sentido depois do login social (1.6); usar `X-Spook-Client: desktop` + código de uso único trocado por token. |
| 1.10 | Privacidade: nomes reais nunca expostos fora do admin | `tests/Feature/Privacy` | P | Teste de integração que varre as respostas públicas e o gateway atrás de campos sensíveis. |

## 2. Social

| # | Funcionalidade | Referência no Antrax | Esforço | Notas para o Spook |
|---|---|---|---|---|
| 2.1 | Amizades: pedir, aceitar, recusar, desfazer; abas Online/Todos/Pendentes/Bloqueados | `FriendController`, `friends/index.tsx` | G | Decisão 1. Tabela `friendships`; eventos no gateway; limites e rate limit de pedidos. |
| 2.2 | Bloquear e desbloquear | `BlockUser`, tabela `blocks` | M | Desfaz amizade, impede DM e menção, **sem revelar** ao bloqueado; mensagens do bloqueado ocultas no cliente (decidir em grupo/servidor). |
| 2.3 | Presença dos amigos | canal `friends.{user}` | M | Reaproveitar presença do gateway; respeitar Invisível/DND; assinar só amigos. |
| 2.4 | Convidar amigo para o servidor por DM | `InviteController::inviteFriend` | P | Depende de 2.1; cria convite e manda mensagem na DM. |
| 2.5 | Chamada em DM com toque (tocar, atender, recusar) | `DirectCallRoster`, `incoming-calls.tsx`, job `EndDirectCall` | M | Voz em DM já existe; falta o estado "tocando" (evento no gateway, timeout por job River), tela de chamada recebida, push/notificação nativa e sons (4.3). |
| 2.6 | Aviso de DM no app (toast com "Abrir") | `use-direct-message-notice.ts` | P | Parcial no Spook; conferir cobertura e respeitar DND/silenciar. |
| 2.7 | Cartão de perfil (popover) com ação de amizade, cargos e apelido | `profile-card.tsx`, `MemberProfileController` | M | Mostra avatar, banner, bio, pronomes, status personalizado, cargos, "membro desde"; botões de amizade/bloqueio/DM. Depende do perfil (seção 5). |

## 3. Servidores e administração

| # | Funcionalidade | Referência no Antrax | Esforço | Notas para o Spook |
|---|---|---|---|---|
| 3.1 | Permissões por canal (overwrites por cargo) e canal privado | `ChannelOverwriteController`, `channel-permissions-editor.tsx`, `PermissionResolver` | G | Estender `perm` com overwrites (allow/deny por cargo e por membro); invalidar assinaturas do gateway e voz ao mudar; testes de matriz de permissões; UI de editor por canal. Decisão 6. |
| 3.2 | Banir e desbanir com motivo | `BanController`, `bans`, permissão `BanMembers` | M | Nova permissão; derruba sessões do gateway e a voz; bloqueia convites e reentrada; lista de banidos nas configurações. |
| 3.3 | Log de auditoria | `AuditAction`, `audit_logs`, `audit-log-settings.tsx` | M | Registrar canal, cargo, kick, ban, mute, convite, ícone, apelido; escrita via eventos internos; retenção e paginação; só quem tem permissão lê. |
| 3.4 | Apelido por servidor (endpoint + UI) | `MemberNicknameController` | P | A coluna `guild_members.nickname` já existe; falta endpoint, permissão (mudar o próprio / gerenciar apelidos) e UI. |
| 3.5 | Mutar e desconectar na voz (moderador) | `SetVoiceMute`, `DisconnectFromVoice`, `MuteMembers` | M | Pela porta de saída do `voice` (LiveKit `MutePublishedTrack`/`RemoveParticipant`); nova permissão; estado "mutado pelo servidor" no payload. |
| 3.6 | `@everyone` e `@cargo` com permissão `MentionEveryone` | `Mentions`, `mention_everyone` | M | Hoje só `@username`. Define o que é `@here`; respeitar mute/nível de notificação; limite de fan-out no push. |
| 3.7 | Mensagem de sistema "fulano entrou" | `MessageType::MemberJoined` | P | Tipo de mensagem novo; ligado ao aceite do convite; opção de desligar por servidor (sugestão). |
| 3.8 | Tópico de canal | `UpdateChannelRequest` | P | Até 1024 caracteres; mostrar no cabeçalho do canal. |
| 3.9 | Limites de domínio configuráveis | `config/concord.php` | P | Servidores por usuário, canais, membros, cargos, tamanhos: via env, com valores padrão do SPEC. |
| 3.10 | Excluir servidor com confirmação por senha | `DestroyServerRequest` | P | Usa a confirmação de senha (1.7); apagar arquivos por job. |

## 4. Mensagens e voz

### Mensagens (todos)

| # | Funcionalidade | Referência no Antrax | Esforço | Notas |
|---|---|---|---|---|
| 4.1 | Autocompletar de menção `@` | `mention-suggestions.tsx`, `lib/mentions.ts` | M | Só front; sugerir membros do canal (e cargos/`@everyone` após 3.6); teclado completo e acessível. |
| 4.2 | Menção a cargo | `Mentions.php` | P | Junto de 3.6. |
| 4.3 | Cartão de convite inline ao colar link de convite | `lib/invite-links.ts`, `invites/show.tsx` | P | Detectar links do próprio domínio e renderizar cartão com ícone, nome, membros e botão entrar. |
| 4.4 | Exibir "(editada)" com `edited_at` | `MessageController` | P | Conferir se já existe no Spook; se não, adicionar. |

### Voz e vídeo (todos, **menos soundboard**)

| # | Funcionalidade | Referência no Antrax | Esforço | Notas |
|---|---|---|---|---|
| 4.5 | Sons de evento (entrar, sair, transmissão, toque de chamada) | `call-sounds.ts`, `call-sound-settings.ts` | P | Assets próprios (sem copiar); configurações por tipo de som; respeitar DND. Ligado a 2.5. |
| 4.6 | Espectadores da transmissão (quem assiste cada tela) | `StreamViewerRegistry`, `stream-viewers.tsx` | M | Estado no backend ou via metadados do LiveKit; evento ao entrar/sair da visualização. |
| 4.7 | Pré-visualização da tela compartilhada | `ScreenPreviewController`, `use-screen-preview.ts` | M | Miniatura periódica (baixa resolução) antes de entrar na transmissão; cuidar de custo de banda. |
| 4.8 | Escolher quais telas assistir (várias telas na sala) | `lib/screen-watch.ts` | M | Cada espectador assina só o que quer; economiza banda. |
| 4.9 | Layouts de chamada: mosaico, destaque, esconder quem não fala | `call-layout.ts`, `use-call-layout.ts` | M | Persistir preferência por usuário; acessível por teclado. |
| 4.10 | Trocar a fonte da tela sem parar o compartilhamento | `screen-source-swap.ts` | M | Web e desktop (Rust). |
| 4.11 | Indicador de rede (latência e perda) | `network-indicator.tsx`, `connection-stats.ts` | P | Existe parcial (qualidade do enlace no cartão de voz); completar com perda e RTT. |
| 4.12 | Tela cheia que esconde controles por ociosidade | `use-fullscreen-idle.ts` | P | |
| 4.13 | Sincronizar estado de voz com webhooks do LiveKit | `LiveKitWebhookController`, `ReconcileVoiceAccess` | M | Reconciliação de quem está na sala (cai conexão sem aviso); job River periódico como rede de segurança. |

## 5. Perfil e personalização (todos)

| # | Funcionalidade | Referência no Antrax | Esforço | Notas |
|---|---|---|---|---|
| 5.1 | Banner (imagem ou cor) | `ProfileImageController`, `banner_path` | M | Upload pelo storage S3, thumbnail, EXIF removido, limites de tamanho; cor sólida como alternativa. |
| 5.2 | Bio e pronomes | `profile_fields` | P | Limites de tamanho; exibidos no cartão de perfil (2.7). |
| 5.3 | Avatar animado (GIF/WebP) | `avatars.show` | P | Conferir se o processamento atual preserva a animação; limite de tamanho. |
| 5.4 | Idiomas pt-BR e inglês (i18n) | `lib/i18n.ts`, `lang/` | G | Decisão 4. Introduzir catálogo de mensagens e teste que falha se faltar tradução; só depois da UI estável. |
| 5.5 | Frases de carregamento temáticas | `use-flexx.ts` | P | Opcional; identidade própria do Spook (não copiar as frases). |

## 6. App desktop

| # | Funcionalidade | Referência no Antrax | Esforço | Notas |
|---|---|---|---|---|
| 6.1 | Auto-update (ao abrir e com o app aberto) + aviso de versão | `update-*.js`, `deploy/publish-desktop.sh` | M | `tauri-plugin-updater` com assinatura de updates (chave privada só em secret do CI); manifesto de versão publicado a partir do workflow Desktop; teste com versão antiga. |
| 6.2 | Página de download gerada no deploy | `build-download-page.mjs` | P | Gerada a partir das releases; links por SO. |
| 6.3 | Splash/tela de "verificando atualizações" | `splash.js` | P | Junto de 6.1. |
| 6.4 | Aviso de nova versão do app (web) | `use-deploy-gap.ts` | P | Comparar versão do build com `/api/version`; banner para recarregar. |
| 6.5 | (Opcional) Plano mobile Expo | `docs/MOBILE.md` | G | Decisão 5; só planejamento. |

## 7. Admin

Itens novos, além do `/admin` já entregue:

| # | Funcionalidade | Esforço | Notas |
|---|---|---|---|
| 7.1 | **Gráficos melhores** | M | Hoje a maioria dos blocos é tabela. Trocar por visualizações: séries temporais (linhas/áreas) para mensagens, contas novas, conexões do gateway, pessoas em chamadas, tráfego do LiveKit; barras horizontais para maiores tabelas do banco e armazenamento por tipo; medidores (gauge) para disco, memória, pool de conexões, perda de pacotes/jitter; sparklines nos cartões; heatmap de atividade por hora e dia; legendas, tooltips e paleta de `packages/brand`; tabela acessível por baixo de cada gráfico; tema claro/escuro; skeletons de carregamento. Seguir o skill de dataviz da casa. |
| 7.2 | **Histórico persistido do LiveKit** (amostra por minuto, picos, tráfego do mês, saúde) | M | Job River de amostragem + tabela de séries com retenção; alimenta os gráficos de 7.1. |
| 7.3 | Capacidade do servidor (limites de CPU/memória do LiveKit, tráfego/mês do plano) | P | Config por env; barra de uso vs limite. |
| 7.4 | Rate limits nomeados por ação (criar servidor/canal/convite, enviar mensagem, pedido de amizade, token de voz, moderação) | M | Revisar a cobertura do `platform/ratelimit`; painel mostra bloqueios recentes (opcional). |
| 7.5 | Página de manutenção | P | Servida pelo Caddy durante o deploy. |

## 8. Fora da lista (decidido não fazer, por enquanto)

2FA TOTP, código de cadastro, soundboard, boost, PIX e doação (específicos do Antrax), Laravel Pulse (o Spook já tem OTel + Grafana + Tempo), seletor de tela próprio do Electron (o Spook captura em Rust), créditos de terceiros e splash/identidade do Antrax.

## Como executar depois

1. Para cada onda, abrir uma conversa curta de brainstorming (decisões da seção "Decisões que precisam do dono") e registrar as escolhas no SPEC 5.5 (bloco "Adicional: ...") no mesmo commit.
2. Uma funcionalidade por vez ou por grupo coeso: backend (migration aditiva, sqlc, handler → service → store, OTel), regeneração (OpenAPI, sqlc, orval, fixtures), web, testes (unitários, integração, E2E), docs (SPEC, `VALIDACAO-MANUAL.md`, `RELATORIO-ADICIONAIS.md`).
3. Rodar `scripts/verify.sh` antes de cada push e confirmar CI, Deploy e Desktop verdes.
4. Migrations seguintes continuam em `00010_*`.
