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
- [ ] Quando houver SMTP (decisão do plano): implementar o `user.EmailChangeVerifier` (hoje nulo) para confirmar o e-mail novo antes de trocar, e a verificação/recuperação por e-mail. Enquanto isso a troca de e-mail é direta e protegida só pela confirmação de senha.
- [ ] Decidir se quer remover metadados (EXIF/GPS) de avatar e banner: exigiria reprocessar as imagens no servidor (um job River) e perderia a animação de GIF/WebP; hoje são servidos exatamente como enviados.
- [ ] (Opcional) Apagar do S3 o avatar/banner antigo quando a pessoa troca a imagem (hoje só a exclusão da conta limpa os arquivos).
