# Pendências do dono

Consolidado em 03/11/2026 a partir de `deploy/README.md`, `apps/desktop/README.md`, `SPEC.md` (Fase B, seção 10 e "Adicionais"), `VALIDACAO-MANUAL.md` e das notas dos lotes. Nenhum item é novo: só foram unidos os duplicados e acrescentado o passo a passo. Convenções: `gh` já autenticado no repositório `devGustavoMuniz/spook`; `gh secret set NOME < arquivo` (ou `printf %s "valor" | gh secret set NOME`) nunca exibe o valor; Variables não são segredo (`gh variable set NOME --body valor`). Depois de criar Secrets/Variables, **refaça o deploy** (Actions > Deploy > Run workflow, ou um push na `main`), porque o `write-env` só grava o `.env` do servidor durante o deploy.

## Resumo

| # | Item | Bloqueia o quê | Esforço |
| --- | --- | --- | --- |
| A1 | Chave do updater (`TAURI_SIGNING_PRIVATE_KEY`) | `.sig` e `latest.json` do desktop; atualização automática | 10 min |
| A2 | Tag `desktop-v0.1.0` e publicar o release | página `/download` com versão; instaladores públicos; updater | 20 min (+ build) |
| A3 | SMTP (envio de e-mail) | verificação de e-mail, recuperação de senha, troca de e-mail confirmada | 1 h (+ DNS) |
| A4 | `SPOOK_SECRET_KEY` | login social estável e e-mails na fila entre deploys | 2 min |
| A5 | App OAuth do Google | "Entrar com Google" e vincular conta | 20 min |
| A6 | App OAuth do Discord | "Entrar com Discord" e vincular conta | 15 min |
| A7 | `PUBLIC_URL` conferida | "Convidar para servidor" pela DM (503 sem ela), links de e-mail e callbacks | 2 min |
| A8 | Deep link `spook://` no Rust | "Entrar pelo navegador" no desktop | M (código Rust) |
| A9 | Conceder permissões novas aos cargos | Banir, Mutar, Desconectar, Gerenciar apelidos, Ver auditoria e `@everyone` nos servidores existentes | 5 min por servidor |
| B1 | Limites (`LIMIT_*`, `EVERYONE_PUSH_MAX`, `AUDIT_RETENTION_DAYS`, `ADMIN_DISK_PATH`, `RATELIMIT_*`) | nada (têm padrão) | 2 min cada |
| B2 | `LIVEKIT_MONTHLY_TRAFFIC_GB` e `LIVEKIT_SAMPLES_RETENTION_DAYS` | barra de uso mensal no `/admin` | 2 min |
| B3 | `REQUIRE_EMAIL_VERIFICATION=true` | exigir e-mail verificado para criar servidor e convite | 2 min (depois de A3) |
| B4 | Cloudflare Access em `/admin` | nada (segunda barreira opcional) | 15 min |
| B5 | Regras de cache da Cloudflare (`/version.json`, `/sw.js`) | aviso de nova versão mais rápido | 10 min |
| B6 | Certificados de assinatura de código (Apple, Windows) | aviso do Gatekeeper/SmartScreen na primeira abertura | G (conta paga) |
| B7 | Grafana Cloud e `SPOOK_OTLP_ENDPOINT` | traces e métricas em produção | 1 h |
| B8 | Backup do Postgres e do Garage | recuperação de desastre | M |
| B10 | Login social em conta existente e sessão persistente (conhecer o risco residual) | nada (já ativo) | 5 min |
| C1 | Fase B: benchmarks contra produção | números finais do SPEC (RNF) | 1 a 2 dias |
| C2 | Decisões de produto e de limites | nada (valem os padrões atuais) | 30 min |
| D1 | Validação manual (ver `VALIDACAO-MANUAL.md`) | fechar os `[ ]` das fases e dos adicionais | 1 a 2 dias |

---

## A. Bloqueia funcionalidades

### A1. Chave de assinatura do updater (secrets `TAURI_SIGNING_PRIVATE_KEY` e `..._PASSWORD`)
Sem eles o workflow Desktop compila, mas não gera `.sig` nem `latest.json`: os apps instalados não conseguem se atualizar. A chave pública já está em `apps/desktop/src-tauri/tauri.conf.json` (`plugins.updater.pubkey`); o par foi gerado com `pnpm --filter @spook/desktop tauri signer generate -w <arquivo> -p <senha>`.

1. Se você ainda tem o par original, use-o. Se não, gere um novo **e troque a `pubkey` no `tauri.conf.json`** (commit + push antes da tag; apps já instalados com a chave antiga não atualizam):
   ```sh
   pnpm --filter @spook/desktop tauri signer generate -w ~/spook-updater.key -p '<senha-forte>'
   ```
2. Crie os secrets (sem exibir os valores):
   ```sh
   gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/spook-updater.key
   printf %s '<senha-forte>' | gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD
   ```
3. **Guarde um backup da chave privada e da senha fora do repositório** (gerenciador de senhas). Se ela se perder, ninguém com o app instalado recebe atualização; trocar a chave tem o mesmo efeito.

### A2. Publicar o primeiro release do desktop (`desktop-v0.1.0`)
Só depois disso `/download` mostra a versão ("Ainda não há versão publicada" enquanto for rascunho) e o updater enxerga `latest.json`.

1. Confira que `apps/desktop/package.json` e `apps/desktop/src-tauri/Cargo.toml` estão em `0.1.0` (estão) e que o workflow **Desktop** está verde na `main` nas 4 plataformas (GitHub > Actions > Desktop).
2. Crie e envie a tag (precisa ser igual à versão do `package.json`):
   ```sh
   git tag desktop-v0.1.0 && git push origin desktop-v0.1.0
   ```
3. Espere o workflow Desktop terminar. Ele cria um **release rascunho** "Spook 0.1.0" com os instaladores (`Spook-0.1.0-<so>-<arq>.<ext>`), os `.sha256`, os `.sig` e o `latest.json`. Confira esses arquivos em GitHub > Releases.
4. Edite o rascunho (notas da versão) e clique em **Publish release**. Rascunho não conta para `releases/latest`.
5. Confira: abra `https://spook.dottadigital.com/download` (versão, tamanhos, SHA-256) e `curl -sL https://github.com/devGustavoMuniz/spook/releases/latest/download/latest.json`.
6. Teste a atualização: instale 0.1.0, depois repita o processo com 0.1.1 (suba a versão nos dois arquivos, commit, tag `desktop-v0.1.1`, publique) e abra o app antigo (roteiro: `VALIDACAO-MANUAL.md`, "Atualização automática do desktop"). Se a build do macOS Intel falhar, o `latest.json` sai sem `darwin-x86_64`.
7. Antes de divulgar: defina o canal de feedback dos usuários (SPEC 10, questão 4).

### A3. SMTP (e-mail transacional)
Sem `SMTP_HOST` o app roda em **modo degradado**: nada de verificação nem recuperação de senha por e-mail, troca de e-mail direta. Esquecimento de senha nesse modo: `ssh <vps> "sudo -iu spook /srv/spook/prod/deploy/admin.sh reset-password <username>"` e repasse o link (30 min, uso único) por um canal seguro.

1. Escolha o provedor (Resend, Amazon SES, Brevo ou o SMTP do seu domínio) e **verifique o domínio remetente**: no DNS da Cloudflare crie os registros SPF (TXT) e DKIM (TXT/CNAME) que o provedor mostrar; espere o status "verified".
2. Crie as Variables e os Secrets (587 = STARTTLS; 465 = TLS direto; o app recusa enviar credenciais se o servidor não oferecer STARTTLS):
   ```sh
   gh variable set SMTP_HOST --body smtp.exemplo.com
   gh variable set SMTP_PORT --body 587
   gh variable set SMTP_FROM --body 'Spook <no-reply@dottadigital.com>'
   gh secret set SMTP_USER < arquivo-com-o-usuario
   gh secret set SMTP_PASSWORD < arquivo-com-a-senha
   ```
3. Refaça o deploy. Teste: cadastre uma conta de teste; deve chegar o e-mail "Confirme seu e-mail". Teste também "Esqueci minha senha".
4. Detalhes: `deploy/README.md` seção 2.1. Os modelos de e-mail ficam em `server/internal/platform/mailer/templates.go` (opcional: ajustar `Reply-To`/texto).

### A4. `SPOOK_SECRET_KEY`
Assina o estado do OAuth e cifra os tokens dos e-mails na fila. Sem ela a chave é aleatória a cada reinício do container: logins sociais em andamento e e-mails na fila no momento do deploy se perdem (ninguém fica sem conta).
```sh
openssl rand -hex 32 | gh secret set SPOOK_SECRET_KEY
```
Não troque depois sem necessidade (invalida estados e e-mails pendentes). Refaça o deploy.

### A5. App OAuth do Google
1. console.cloud.google.com > selecione/crie um projeto > **APIs e serviços > Tela de consentimento OAuth** (tipo Externo; nome "Spook"; e-mail de suporte) e **publique** o app (em modo "Teste" só os e-mails cadastrados entram).
2. **APIs e serviços > Credenciais > Criar credenciais > ID do cliente OAuth > Aplicativo da Web.**
3. **URIs de redirecionamento autorizados:**
   - `https://spook.dottadigital.com/api/auth/social/google/callback`
   - (teste local) `http://localhost:8090/api/auth/social/google/callback`
4. Copie o ID e o segredo e crie:
   ```sh
   gh variable set GOOGLE_CLIENT_ID --body '<id>.apps.googleusercontent.com'
   gh secret set GOOGLE_CLIENT_SECRET < arquivo-com-o-segredo
   ```
5. Refaça o deploy e teste "Entrar com Google" em `/login` e "Vincular" em Configurações > Perfil > Contas vinculadas. Exige A4 e `PUBLIC_URL` correto (A7). Se o e-mail do Google (verificado) for o mesmo de uma conta que já existe, o login **vincula e entra** nessa conta (ver B10).

### A6. App OAuth do Discord
1. discord.com/developers/applications > **New Application** (nome "Spook") > **OAuth2**.
2. Em **Redirects** adicione: `https://spook.dottadigital.com/api/auth/social/discord/callback` (e, para teste local, `http://localhost:8090/api/auth/social/discord/callback`). Salve.
3. Copie o **Client ID** e o **Client Secret** (Reset Secret) e crie:
   ```sh
   gh variable set DISCORD_CLIENT_ID --body '<client-id>'
   gh secret set DISCORD_CLIENT_SECRET < arquivo-com-o-segredo
   ```
4. Refaça o deploy e teste como no Google.

### A7. `PUBLIC_URL` em produção
Base dos links dos e-mails, dos callbacks OAuth e de "Convidar para servidor" pela DM (`<PUBLIC_URL>/invite/<código>`; sem ela esse endpoint responde 503). O padrão do compose de produção já é `https://spook.dottadigital.com`; só confirme que é o mesmo domínio que o app serve (o cartão de convite inline só reconhece links do próprio host). Para trocar: `gh variable set PUBLIC_URL --body https://...` e refaça o deploy (o `write-env` grava; o `deploy.yml` também usa a variável na conferência do `/healthz`).

### A8. Deep link `spook://` no desktop (Rust)
O backend e o módulo `apps/web/src/desktop/browser-login.ts` do "Entrar pelo navegador" estão prontos, mas o app ainda não recebe `spook://auth?code=...`. Falta, em `apps/desktop/src-tauri`: adicionar `tauri-plugin-deep-link` (esquema `spook`) e `tauri-plugin-single-instance` (Windows/Linux, para o link chegar ao app já aberto); a permissão `deep-link:default` em `capabilities/default.json`; o esquema em `tauri.conf.json`. Depois ligue `VITE_DESKTOP_BROWSER_LOGIN=true` no build do desktop (capability `browserLogin`, desligada por padrão) e teste nos 3 SOs. Depende de A5/A6 para fazer sentido.

### A9. Conceder as permissões novas aos cargos dos servidores existentes
As migrações `00012` e `00013` **não concedem** nenhuma permissão nova a cargo algum (só o "mudar o próprio apelido" ao `@everyone`). Para cada servidor existente:
1. Menu do servidor (nome do servidor, canto superior esquerdo) > **Configurações do servidor > Cargos** (ou **Cargos** no menu).
2. Selecione o cargo de moderação/anúncio e marque, no grupo **Moderação**: *Banir membros*, *Mutar membros*, *Desconectar membros*, *Gerenciar apelidos*, *Ver o registro de auditoria*; no grupo **Texto**: *Mencionar @everyone, @here e todos os cargos*. Salve.
3. Dono e Administrador já têm tudo. Depois confira as abas Banimentos e Auditoria nas configurações do servidor.

---

## B. Configuração opcional

Todas são Variables do GitHub repassadas pelo `write-env` e pelo `docker-compose.prod.yml`; vazio ou ausente = padrão do SPEC. Valor fora da faixa faz o backend recusar o boot (veja o log). Refaça o deploy depois de definir.

### B1. Limites de domínio e de taxa
```sh
gh variable set LIMIT_GUILDS_PER_USER    --body 100     # 1 a 10000
gh variable set LIMIT_CHANNELS_PER_GUILD --body 500     # 1 a 5000
gh variable set LIMIT_MEMBERS_PER_GUILD  --body 10000   # 1 a 1000000
gh variable set LIMIT_ROLES_PER_GUILD    --body 250     # 2 a 1000
gh variable set LIMIT_INVITES_PER_GUILD  --body 1000    # 1 a 100000
gh variable set LIMIT_ATTACHMENT_MB      --body 25      # 1 a 100
gh variable set EVERYONE_PUSH_MAX        --body 200     # 0 a 100000; 0 desliga o push em massa
gh variable set AUDIT_RETENTION_DAYS     --body 90      # 1 a 3650
gh variable set ADMIN_DISK_PATH          --body /       # volume que o /admin mede
gh variable set RATELIMIT_MESSAGES_SEND_PER_MIN --body 60   # exemplo; 1 a 100000 por minuto
```
Os `RATELIMIT_<NOME>_PER_MIN` existem para cada limitador (nomes no `docker-compose.prod.yml`, ex.: `SERVERS_CREATE`, `MESSAGES_SEND`, `AUTH_FORGOT`, `VOICE_TOKEN`). Baixar um limite não remove o que já existe. Se subir `LIMIT_ATTACHMENT_MB` acima de 25, confira também o limite de corpo do túnel/Cloudflare e do bucket. Os padrões de canais (500), membros (10000), cargos (250), convites (1000) e dos limites de amizade/chamada/rate limits são decisões do desenvolvimento, não do SPEC (ver C2).

### B2. Capacidade e histórico do `/admin`
```sh
gh variable set LIVEKIT_MONTHLY_TRAFFIC_GB --body 1000        # GB/mês de saída do plano da VPS
gh variable set LIVEKIT_SAMPLES_RETENTION_DAYS --body 35       # 2 a 365 (~50 mil linhas/mês)
```
Sem a primeira, o painel mostra só o tráfego do mês. Confira também os limiares dos medidores (memória/pool 70% e 90%; perda 1% e 3%; jitter 20 ms e 50 ms) com tráfego real e ajuste se preciso.

### B3. Exigir e-mail verificado
Só depois de A3 funcionar e de avisar quem já tem conta (as contas antigas estão como "não verificadas" e verificam por um clique na faixa "Verifique seu e-mail"):
```sh
gh variable set REQUIRE_EMAIL_VERIFICATION --body true
```
Refaça o deploy; criar servidor e criar convite passam a exigir e-mail verificado. Para desligar: `--body false`.

### B4. Cloudflare Access em `/admin` (segunda barreira, não configurada)
O backend já exige admin em toda rota `/api/admin/**`. Para uma barreira antes do app: Cloudflare **Zero Trust > Access > Applications > Add an application > Self-hosted**; domínio `spook.dottadigital.com`, paths `admin*` **e** `api/admin*`; política **Allow** só com o seu e-mail, método **One-time PIN**, sessão de 24 h. Não crie política "Bypass" nem mexa na configuração global da zona. Teste abrindo `/admin` e conferindo se os gráficos carregam. O desktop (Bearer) deixa de alcançar o admin (aceitável). Para desligar, exclua a application. Detalhes em `deploy/README.md` ("Camada extra").

### B5. Regras de cache da Cloudflare (só para este host)
A zona reescreve `.js`/`.json` com `max-age=14400` (Browser Cache TTL), o que atrasa o aviso de nova versão. Cloudflare > **Caching > Cache Rules > Create rule** "spook: sem cache em sw, manifest e version": condição `http.host eq "spook.dottadigital.com" and (http.request.uri.path in {"/sw.js" "/manifest.webmanifest" "/version.json"})`; ação *Bypass cache*. **Não altere a configuração global da zona** (afeta outros sites). Teste: `curl -s https://spook.dottadigital.com/version.json` deve trazer o sha do deploy atual.

### B6. Assinatura de código do desktop
Sem certificados, o Gatekeeper (macOS) e o SmartScreen (Windows) avisam na primeira abertura (a página `/download` explica como abrir mesmo assim). Para remover: Apple Developer Program (assinatura + notarização) e certificado de assinatura da Microsoft (ou Azure Trusted Signing); os secrets entram no workflow Desktop. Custo recorrente: decisão sua.

### B7. Observabilidade em produção (Grafana Cloud)
Hoje `SPOOK_OTLP_ENDPOINT` é vazio em produção. Crie a conta gratuita no Grafana Cloud, gere o token de ingestão e coloque um coletor OpenTelemetry leve no VPS (entra no orçamento de memória da tabela 1.2 de `deploy/README.md`); aponte `SPOOK_OTLP_ENDPOINT` para ele. Prometheus, Loki e Grafana **não** rodam no VPS (SPEC, Fase B).

### B8. Backup
SPEC 10, questão 3: não há rotina. Postgres por `pg_dump` agendado; dados em volumes nomeados do Docker rootless (`postgres-data`, `garage-meta`, `garage-data`); estratégia do Garage a definir (snapshot dos volumes ou `rclone` para outro bucket). Teste a restauração, não só a cópia.

### B9. Limpeza e itens menores
- Usuários de teste em produção (`bench_*`, `smoke_*` e os que você criou): o painel `/admin` > Usuários e o fluxo "Excluir conta" resolvem; remoção por SQL em `bench/README.md` seção 4.
- Sons de chamada sintetizados: ouça em Configurações > Voz e vídeo; para outro timbre ajuste as receitas em `apps/web/src/features/voice/call-sounds.ts`.
- Desktop (Rust) pendente: assinatura por faixa, troca de fonte da tela e estatísticas de rede, para ligar "Assistir", "Trocar janela/tela" e o indicador completo no app desktop. O comando `app_set_locale` (menu da bandeja em inglês) ainda não foi compilado localmente (sem `cargo`); o job Desktop do CI compila, e se falhar o app segue em pt-BR na bandeja.
- Disco do Docker local: se aparecer `No space left on device`, rode `docker system df`, `docker builder prune` e remova imagens/volumes de projetos antigos.

### B10. Login social em conta existente e "Manter conectado" (nada a configurar)
Entrou como adicional (RF30; SPEC 5.5, bloco "login social em conta existente e sessão persistente"); a **regra anterior "sem vínculo automático por e-mail" foi substituída**. O que mudou para você:
- Se o Google/Discord informa o e-mail como **verificado** e ele é igual ao de uma conta do Spook, a pessoa **entra nessa conta** e a conta social é vinculada (antes: "Já existe uma conta com esse e-mail..."). Se o e-mail da conta do Spook não estava verificado, ele passa a estar e **todas as outras sessões dela caem** (proteção contra quem cadastrou o e-mail alheio com senha antes). O log do servidor registra `login social: conta existente vinculada pelo e-mail verificado do provedor` (nível WARN nesse caso).
- **Risco residual que você deve conhecer:** nesse caso especial a senha que o invasor definiu continua valendo; o dono real pode trocá-la em "Esqueci minha senha" (precisa do SMTP, A3) ou em Configurações. Se quiser endurecer, a alternativa é apagar a senha da conta quando ela não estava verificada (a pessoa passaria a entrar só pelo provedor e definiria uma senha de novo); não fiz para não surpreender quem se cadastrou legitimamente com senha. Decida se quer isso.
- Sessões agora duram **90 dias deslizantes** (cada uso renova) com "Manter conectado" marcado, que é o padrão; desmarcado, 24 h e some ao fechar o navegador. A causa de "o login expira" era o prazo fixo de 30 dias sem renovação. Sessões já existentes viram "lembradas" (migration `00016`, aditiva) e passam a deslizar no primeiro uso. Para revogar: Configurações > Perfil > "Sessões ativas".
- Nenhum segredo, variável ou passo de deploy novo.

---

## C. Decisões

### C1. Fase B (benchmarks, contra produção)
Nada foi executado; tudo está escrito em `bench/` (SPEC, "Fase B"). Pré-requisito: Grafana Cloud (B7). Passos: `bench/README.md` descreve método e comandos.
1. Medição interna (sem Cloudflare): `bench/scripts/run-internal.sh` (healthz e `me.js` nos dois sistemas) e o `Server-Timing` do Spook em produção; resultados em `bench/results/`.
2. Medição pela internet alternando os sistemas: `bench/scripts/run-alternating.sh`.
3. Cenários k6 por fase: Fase 1 (p95 de login e RAM ociosa), Fase 2 (`messages.js`), Fase 3 (`gateway-latency.js`, `gateway-connections.js`; Spook vs Laravel Reverb), Fase 4 (`gateway-fanout.js`), Fase 5 (`voice-token.js` e `bench/scripts/livekit-load-test.sh`), Fase 6 (`upload.js`, `read-states.js`), Fase 7 (RAM ociosa/em call, instalador e boot, Tauri vs Electron: manual). k6 roda em Docker (`bench/scripts/vps-k6.sh` para o VPS).
4. Registre lado a lado "internet" e "interno" e marque os `[ ]` da Fase B no `SPEC.md`.

### C2. Decisões abertas e valores adotados por mim
Valem os padrões atuais até você decidir; ajuste se quiser outros.
- SPEC 10: metas de performance da seção 4 (confirmar após o baseline); limites de negócio (100 servidores, 25 MB, 10 pessoas por DM em grupo); canal de feedback; disponibilidade do nome Spook (INPI e lojas); revisão do vetor final por um designer.
- Canais não herdam as permissões da categoria; banir não revoga os convites de quem foi banido (SPEC 5.5).
- Limites adotados: 500 canais, 10000 membros, 250 cargos, 1000 convites; 1000 amigos, 200 pedidos pendentes, 500 bloqueados; pedidos de amizade 20 por hora; toque de 45 s; rate limits em `server/internal/app/ratelimits.go` (servidor 5 de rajada e 2/min, canal e cargo 30, convite 20, token de voz 10 e 30/min, perfil 10 e 20/min, fixar 15 e 30/min, espectador 60 e 180/min); retenção de 35 dias do histórico e janelas 24 h/5 min, 7 d/1 h, 30 d/1 dia.
- EXIF/GPS de avatar e banner não é removido (exigiria reprocessar no servidor e perderia animação de GIF/WebP). Avatar/banner antigo não é apagado do S3 na troca (só na exclusão da conta).
- Idioma só no navegador (`localStorage`); push em inglês exigiria `users.locale` e tradução no backend. `detail` de erro sem entrada em `lib/server-details.ts` aparece em pt-BR; o `/admin` é só pt-BR.
- Chamada em DM no CI: `e2e/social.spec.ts` pula o teste sem `LIVEKIT_*`; dar LiveKit ao job `e2e` faria o `voice-off.spec.ts` pular. Escolha qual cobertura prefere.
- Uma única instância do backend: estado de voz, espectadores e `voice_reconcile` assumem um processo; réplicas exigiriam estado compartilhado.
- Fora de escopo por decisão do dono: soundboard, 2FA, código de cadastro, mobile (Expo).

---

## D. Validação manual (ver `VALIDACAO-MANUAL.md`)

Só o dono consegue conferir (áudio, hardware, SO, produção, aparência). Roteiros por seção, a executar em máquina real:
- Voz: ruído (3 níveis), porta, teste de microfone, volume até 200% no desktop, qualidade da tela e Picture-in-Picture.
- Desktop: bandeja, início com o sistema, contador no ícone, clique na notificação, atualização automática, instalação nos 3 SOs, voz e tela nativas.
- Conferência com LiveKit real: espectadores (inclusive o desktop), reconciliação (derrube o LiveKit por 1 minuto), histórico depois de algumas horas (RF28), mute/desconexão por moderação, chamada em DM com toque e push de chamada.
- Contas: editores de perfil e cartão em navegador real, exclusão de conta em produção, SMTP e OAuth reais (depois de A3, A5, A6).
- Menções em massa, mensagem de entrada e tópico; inglês (revisão da tradução); aparência de tudo nos dois temas e em 390 px.
- `/admin`: números e métricas de mídia contra produção.
