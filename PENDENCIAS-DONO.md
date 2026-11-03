# Pendências do dono

## Admin (gráficos)
- [ ] Decidir/implementar no backend (lote seguinte) os dados que os gráficos já sabem receber: contagem de mensagens por hora (alimenta o `Heatmap`), histórico do LiveKit (item 7.2) e uso de disco no `/admin/system`. Até lá a tela mostra o que existe e avisa.
- [ ] Conferir os limiares dos medidores (memória/pool 70% e 90%; perda 1% e 3%; jitter 20 ms e 50 ms) em produção com tráfego real e ajustar se preciso.

## Desktop (distribuição e atualização)
- [ ] Criar os secrets do GitHub `TAURI_SIGNING_PRIVATE_KEY` e `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` com a chave do updater (`gh secret set NOME < arquivo`, sem exibir o valor) e **guardar um backup da chave privada** fora do repositório: se ela se perder, os apps instalados não aceitam mais atualização. Sem os secrets o workflow Desktop compila, mas não gera `.sig` nem `latest.json`.
- [ ] Publicar o release rascunho gerado pela tag `desktop-v<versão>` (GitHub > Releases > Publish release; passo a passo em `apps/desktop/README.md`). Só depois disso a página `/download` mostra a versão e os apps recebem atualizações.
- [ ] Testar a atualização de uma versão antiga para a nova em cada SO (roteiro em `VALIDACAO-MANUAL.md`, "Atualização automática do desktop"): publique 0.1.0, instale, depois publique 0.1.1.
- [ ] (Opcional) Certificados de assinatura de código: Apple Developer Program (assinatura + notarização do macOS) e certificado da Microsoft (ou Azure Trusted Signing) para o Windows. Sem eles o SmartScreen e o Gatekeeper continuam avisando na primeira abertura (a página `/download` explica como abrir mesmo assim).
- [ ] (Opcional) Regra de cache "Bypass" da Cloudflare para `/version.json`, se o Browser Cache TTL estiver reescrevendo arquivos estáticos (o aviso de nova versão do web depende de esse arquivo não ficar em cache).

## Voz e mensagens (lote 2)
- [ ] Ouvir e aprovar os sons de chamada sintetizados (Configurações > Voz e vídeo); se quiser outro timbre, é só ajustar as receitas em `features/voice/call-sounds.ts`.
- [ ] Decidir/implementar no backend (lote seguinte): menção a cargo e `@everyone` (o autocompletar já aceita `kind: "role" | "everyone"`) e lista de espectadores por tela.
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

