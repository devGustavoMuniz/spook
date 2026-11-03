# Pendências do dono

## Admin (gráficos)
- [x] ~~Decidir/implementar no backend os dados que os gráficos já sabem receber (mensagens por hora, histórico do LiveKit, uso de disco)~~: implementado (ver "Voz no backend, histórico do admin e rate limits").
- [ ] Conferir os limiares dos medidores (memória/pool 70% e 90%; perda 1% e 3%; jitter 20 ms e 50 ms) em produção com tráfego real e ajustar se preciso.

## Desktop (distribuição e atualização)
- [ ] Criar os secrets do GitHub `TAURI_SIGNING_PRIVATE_KEY` e `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` com a chave do updater (`gh secret set NOME < arquivo`, sem exibir o valor) e **guardar um backup da chave privada** fora do repositório: se ela se perder, os apps instalados não aceitam mais atualização. Sem os secrets o workflow Desktop compila, mas não gera `.sig` nem `latest.json`.
- [ ] Publicar o release rascunho gerado pela tag `desktop-v<versão>` (GitHub > Releases > Publish release; passo a passo em `apps/desktop/README.md`). Só depois disso a página `/download` mostra a versão e os apps recebem atualizações.
- [ ] Testar a atualização de uma versão antiga para a nova em cada SO (roteiro em `VALIDACAO-MANUAL.md`, "Atualização automática do desktop"): publique 0.1.0, instale, depois publique 0.1.1.
- [ ] (Opcional) Certificados de assinatura de código: Apple Developer Program (assinatura + notarização do macOS) e certificado da Microsoft (ou Azure Trusted Signing) para o Windows. Sem eles o SmartScreen e o Gatekeeper continuam avisando na primeira abertura (a página `/download` explica como abrir mesmo assim).
- [ ] (Opcional) Regra de cache "Bypass" da Cloudflare para `/version.json`, se o Browser Cache TTL estiver reescrevendo arquivos estáticos (o aviso de nova versão do web depende de esse arquivo não ficar em cache).

## Voz e mensagens (lote 2)
- [ ] Ouvir e aprovar os sons de chamada sintetizados (Configurações > Voz e vídeo); se quiser outro timbre, é só ajustar as receitas em `features/voice/call-sounds.ts`.
- [x] ~~Menção a cargo e `@everyone`~~ (feito em "Menções, mensagem de entrada e limites") e ~~lista de espectadores por tela~~ (feito em "Voz no backend, histórico do admin e rate limits").
- [ ] Desktop (Rust): expor assinatura por faixa, troca de fonte da tela e estatísticas de rede para ligar "Assistir", "Trocar janela/tela" e o indicador completo no app.

## Contas e perfil
- [x] ~~`user.EmailChangeVerifier`~~: implementado em `mailflow` (ver "E-mail e login social"). Sem SMTP a troca de e-mail continua direta, protegida pela confirmação de senha.
- [ ] Decidir se quer remover metadados (EXIF/GPS) de avatar e banner: exigiria reprocessar as imagens no servidor (um job River) e perderia a animação de GIF/WebP; hoje são servidos exatamente como enviados.
- [ ] (Opcional) Apagar do S3 o avatar/banner antigo quando a pessoa troca a imagem (hoje só a exclusão da conta limpa os arquivos).

## E-mail e login social
- [ ] **Escolher e criar o envio de e-mail (SMTP).** Resend, Amazon SES, Brevo ou o SMTP do seu domínio. Verifique o domínio remetente (SPF e DKIM no DNS da Cloudflare). Depois: Variables `SMTP_HOST`, `SMTP_PORT` (587 STARTTLS ou 465 TLS) e `SMTP_FROM` (`Spook <no-reply@dominio>`); Secrets `SMTP_USER` e `SMTP_PASSWORD` (`gh variable set` / `gh secret set NOME < arquivo`, sem exibir valores) e refaça o deploy. Passo a passo em `deploy/README.md` 2.1. **Sem isso o app roda em modo degradado**: nada de verificação nem recuperação de senha por e-mail (use `deploy/admin.sh reset-password <username>` para um esquecimento de senha).
- [ ] **Criar `SPOOK_SECRET_KEY`** (Secret, `openssl rand -hex 32`): assina o estado do OAuth e cifra os tokens dos e-mails na fila. Sem ela a chave é aleatória a cada reinício do container (o login social em andamento e e-mails na fila no momento do deploy se perdem; ninguém fica sem conta).
- [ ] **Criar o app OAuth do Google** (console.cloud.google.com, ID do cliente OAuth, aplicativo da Web) com o redirecionamento `https://spook.dottadigital.com/api/auth/social/google/callback` (e o de `http://localhost:8090/...` para testar). Variable `GOOGLE_CLIENT_ID` e Secret `GOOGLE_CLIENT_SECRET`. Publique a tela de consentimento (em "teste" só os e-mails cadastrados entram).
- [ ] **Criar o app OAuth do Discord** (discord.com/developers/applications > OAuth2) com o redirecionamento `https://spook.dottadigital.com/api/auth/social/discord/callback`. Variable `DISCORD_CLIENT_ID` e Secret `DISCORD_CLIENT_SECRET`.
- [ ] (Decisão) Ligar `REQUIRE_EMAIL_VERIFICATION=true` depois que o SMTP funcionar: criar servidor e convidar passam a exigir e-mail verificado. As contas antigas estão como "não verificadas": elas verificam pela faixa "Verifique seu e-mail" (um clique no link).
- [ ] **Deep link do desktop (`spook://`) no Rust.** O backend e o módulo web `apps/web/src/desktop/browser-login.ts` do "Entrar pelo navegador" estão prontos, mas o app desktop ainda não recebe `spook://auth?code=...`. Falta: adicionar `tauri-plugin-deep-link` (esquema `spook`, também com `tauri-plugin-single-instance` no Windows/Linux para o link chegar ao app já aberto) em `apps/desktop/src-tauri`, a permissão `deep-link:default` em `capabilities/default.json` e o esquema em `tauri.conf.json`; depois ligar `VITE_DESKTOP_BROWSER_LOGIN=true` no build do desktop (capability `browserLogin`, desligada por padrão). Testar nos três SOs.
- [ ] (Opcional) Remetente com `Reply-To` ou outro nome: os modelos estão em `server/internal/platform/mailer/templates.go` (texto e HTML, pt-br).

## Moderação e permissões
- [ ] (Opcional) Definir `AUDIT_RETENTION_DAYS` (Variable; padrão 90, de 1 a 3650) se quiser outro prazo para o registro de auditoria.
- [ ] Conceder as permissões novas (Banir, Mutar, Desconectar, Gerenciar apelidos, Ver o registro de auditoria) aos cargos de moderação dos servidores existentes: a migração `00012` **não** concede nenhuma (só o "mudar o próprio apelido" ao `@everyone`).
- [ ] Conferir em produção com LiveKit real o mute do servidor e a desconexão (`VALIDACAO-MANUAL.md`, "Moderação e permissões por canal").
- [ ] Decidir se canais devem herdar as permissões da categoria (hoje não herdam) e se banir deve revogar os convites de quem foi banido (hoje não revoga). Ambos estão registrados em `SPEC.md` 5.5.


## Menções, mensagem de entrada e limites
- [ ] Conceder `Mencionar @everyone, @here e todos os cargos` (MENTION_EVERYONE) aos cargos de moderação/anúncio dos servidores existentes: a migração `00013` **não** concede a nenhum cargo e o `@everyone` do servidor também não a tem.
- [ ] (Opcional) Definir os `LIMIT_*` e `EVERYONE_PUSH_MAX` (Variables/ambiente do backend; ver `deploy/README.md` 7.1). Os limites de canais (500), membros (10000), cargos (250) e convites (1000) são decisões minhas (o SPEC só fixava servidores e anexo): ajuste se quiser outros.
- [ ] Se subir `LIMIT_ATTACHMENT_MB` acima de 25, conferir o limite de corpo do túnel/Cloudflare e do bucket.
- [ ] Rodar as verificações novas de `VALIDACAO-MANUAL.md` ("Menções em massa, mensagem de entrada...").

## Social (amizades, bloqueio e chamada em DM)
- [ ] **`PUBLIC_URL` em produção** (Variable já documentada em `deploy/README.md`): é a base do link enviado por "Convidar para servidor" (`<PUBLIC_URL>/invite/<código>`); sem ela esse endpoint responde 503. Conferir que o valor é o mesmo domínio que o app serve (o cartão de convite inline só reconhece links do próprio host).
- [ ] **Push de chamada**: usa as mesmas chaves VAPID do push de mensagens (nada novo a configurar). Validar em produção (`VALIDACAO-MANUAL.md`, "Social").
- [ ] **LiveKit real para validar o toque**: o backend de testes e o E2E usam LiveKit falso/desligado; a chamada de ponta a ponta com áudio só se confirma com o LiveKit de produção ou de desenvolvimento.
- [ ] (Decisões minhas, ajuste se quiser outras) limites de 1000 amigos, 200 pedidos enviados pendentes e 500 bloqueados; pedidos de amizade a 20 por hora; toque de 45 s; chamar de novo logo após cancelar limitado a 5 de rajada e 1 a cada 5 s. Estão em `server/internal/relationship/relationship.go` e `app/app.go`.
- [ ] (Opcional) E2E da chamada no CI: o spec `e2e/social.spec.ts` pula o teste de chamada quando o backend não tem `LIVEKIT_*`. Para rodá-lo no job `e2e` seria preciso passar valores de desenvolvimento de `LIVEKIT_URL/API_KEY/API_SECRET` ao backend, o que faria o `voice-off.spec.ts` pular (ele só roda sem LiveKit); escolha qual cobertura prefere no CI.

## Voz no backend, histórico do admin e rate limits
- [ ] (Opcional) Definir a Variable `LIVEKIT_MONTHLY_TRAFFIC_GB` (`gh variable set LIVEKIT_MONTHLY_TRAFFIC_GB --body 1000`, em GB de saída por mês do plano da VPS) para o painel mostrar o uso do mês contra o limite; sem ela só aparece o tráfego do mês. Já está ligada no workflow de deploy e no compose de produção.
- [ ] (Opcional) `LIVEKIT_SAMPLES_RETENTION_DAYS` (padrão 35): é a retenção do histórico por minuto (aprox. 50 mil linhas por mês). Mesmo caminho (Variable do GitHub).
- [ ] **`ADMIN_DISK_PATH` e `RATELIMIT_<NOME>_PER_MIN` não estão ligados ao deploy** (valem no ambiente do backend). Para usá-los em produção, acrescente a linha em `environment:` do serviço `spook` em `deploy/docker-compose.prod.yml` (e a Variable no `deploy.yml`). O disco medido por padrão é o `/` do container (disco do Docker na VPS); se o Garage usar outro disco, monte-o e aponte o caminho.
- [ ] **Validar com LiveKit real** os espectadores (inclusive o desktop, que assina todas as telas), a reconciliação (derrubar o LiveKit por um minuto) e o histórico depois de algumas horas (`VALIDACAO-MANUAL.md`, RF28). O E2E de espectadores (`e2e/voice.spec.ts`) só roda com `E2E_VOICE=1` e LiveKit local.
- [ ] (Decisões minhas, ajuste se quiser outras) padrões dos limites novos em `server/internal/app/ratelimits.go` (servidor 5 de rajada e 2/min, canal e cargo 30, convite 20, token de voz 10 de rajada e 30/min, perfil 10 e 20/min, fixar 15 e 30/min, avisar espectador 60 e 180/min); retenção de 35 dias; janelas do histórico (24 h em 5 min, 7 dias em 1 h, 30 dias em 1 dia).
- [ ] **Uma única instância do backend:** o estado de voz, os espectadores e o `voice_reconcile` assumem um só processo (como a produção atual). Se um dia houver réplicas, esse estado precisa ir para um armazenamento compartilhado.
