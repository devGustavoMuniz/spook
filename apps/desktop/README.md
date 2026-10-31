# @spook/desktop

Casca **Tauri 2** do Spook. A interface é o [`apps/web`](../web) buildado em modo desktop; o Rust (`src-tauri`) só traz as
capacidades nativas: chaveiro do SO para o token, instância única, notificações do sistema, estado da janela e links
externos no navegador. Decisões em `SPEC.md` seção 5.5 (Fase 7a). A voz e a tela nativas (Rust + LiveKit SDK) são da Parte 7b.

## Pré-requisitos

- Node 24 e pnpm (`pnpm install` na raiz).
- [Rust estável](https://rustup.rs) e as dependências do Tauri para o seu sistema:
  - **macOS:** Xcode Command Line Tools.
  - **Windows:** Microsoft C++ Build Tools e WebView2 (já vem no Windows 11).
  - **Linux (Debian/Ubuntu):** `sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev libxdo-dev libdbus-1-dev patchelf build-essential curl wget file`.

## Rodar em desenvolvimento

```sh
pnpm infra:up                                  # Postgres, Garage etc. (uma vez)
pnpm --filter @spook/server dev                # backend em :8090 (veja o CLAUDE.md na raiz)
pnpm --filter @spook/desktop tauri dev         # sobe o Vite (:5180) e abre a janela do Tauri
```

Em dev a URL da API é relativa (o proxy do Vite aponta para `localhost:8090`) e o webview carrega `http://localhost:5180`.
O backend aceita essa origem no gateway por padrão; para o CORS da API fora do proxy, inclua-a em `SPOOK_ALLOWED_ORIGINS`.

## Construir

```sh
pnpm --filter @spook/desktop tauri build                    # instaladores do seu SO
pnpm --filter @spook/desktop tauri build --no-bundle        # só o binário (sem instalador)
pnpm --filter @spook/desktop tauri build --bundles deb,appimage   # escolhe os formatos
```

O `beforeBuildCommand` roda `pnpm --filter @spook/web build:desktop` (`vite build --mode desktop`), que lê
[`apps/web/.env.desktop`](../web/.env.desktop): `VITE_API_BASE_URL=https://spook.dottadigital.com`. Para apontar para outro
backend, exporte `VITE_API_BASE_URL` antes do build. O resultado vai para `src-tauri/target/release/bundle/`.

Ícones: gerados de `packages/brand/assets/icon.png` e **versionados** em `src-tauri/icons`. Para refazer:
`pnpm --filter @spook/desktop tauri icon ../../packages/brand/assets/icon.png` (apague `icons/android` e `icons/ios`, que não usamos).

Testes e lint do Rust (a partir de `src-tauri`): `cargo test`, `cargo clippy -- -D warnings`, `cargo fmt --check`.
O `@spook/desktop` fica fora do Turborepo (`pnpm build`/`dev`/`verify.sh`) para o CI de código não compilar Rust.

## Autenticação e chaveiro

1. Login e cadastro enviam `X-Spook-Client: desktop` e o backend devolve o `token` no corpo.
2. O web chama o comando Rust `auth_set_token`, que guarda o token no chaveiro do SO (serviço **Spook**, conta `session-token`):
   Keychain (macOS), Gerenciador de Credenciais (Windows), Secret Service/libsecret (Linux).
3. Ao abrir, `auth_get_token` recupera o token (antes do primeiro render) e as requisições levam `Authorization: Bearer`.
   Não há cookies. O WebSocket usa um ticket de uso único (`POST /api/gateway/ticket`).
4. Sair da conta (ou um 401) chama `auth_clear_token`.

**Sem chaveiro** (por exemplo, Linux sem `gnome-keyring`/KWallet): o token fica **só em memória** e o app avisa que será
preciso entrar de novo ao reabrir. O token nunca é gravado em arquivo, `localStorage` nem cookie.

## O que a CI gera

Workflow [`desktop.yml`](../../.github/workflows/desktop.yml) (`workflow_dispatch`, push na `main` que toque `apps/desktop`,
`apps/web` ou `packages`, e tags `desktop-v*`). Artefatos `Spook-<versão>-<so>-<arquitetura>.<ext>` (+ `.sha256`):

| Plataforma | Runner | Arquivos |
| --- | --- | --- |
| Windows x64 | `windows-latest` | `.exe` (NSIS) |
| macOS arm64 | `macos-latest` | `.dmg` |
| macOS x64 | `macos-latest` (cross-compile, `--target x86_64-apple-darwin`; job experimental) | `.dmg` |
| Linux x64 | `ubuntu-22.04` | `.deb` e `.AppImage` |

Para liberar uma versão: aumente `version` em `package.json` **e** `src-tauri/Cargo.toml` (a CI confere que são iguais),
crie a tag `desktop-v<versão>` e envie. O job `release` cria um **release rascunho** do GitHub com os instaladores; a
publicação é manual.

## Limitações (sem assinatura de código)

Não há certificado de assinatura nem notarização, e não há auto-update. Na primeira abertura:

- **Windows:** o SmartScreen mostra "O Windows protegeu o computador". Clique em *Mais informações* → *Executar assim mesmo*.
- **macOS:** o app tem só assinatura *ad-hoc* e não é notarizado; o Gatekeeper bloqueia. Clique com o botão direito → *Abrir*,
  ou *Ajustes → Privacidade e Segurança → Abrir mesmo assim*. Se disser que está "danificado":
  `xattr -dr com.apple.quarantine /Applications/Spook.app`.
- **Linux:** o AppImage precisa de permissão de execução (`chmod +x`); o `.deb` instala com `sudo apt install ./arquivo.deb`.
- No macOS o `Info.plist` (`src-tauri/Info.plist`) e os entitlements (`entitlements.plist`) já declaram microfone, câmera e
  gravação de tela para a voz da 7b.
- No desktop, clicar numa notificação nativa só traz o app à frente (o plugin não tem callback de clique).
- Voz, vídeo e tela: indisponíveis até a 7b ("Voz no desktop ainda não disponível nesta versão").

## Estrutura

```
src-tauri/
  Cargo.toml  build.rs  tauri.conf.json  Info.plist  entitlements.plist
  capabilities/default.json   permissões mínimas da janela "main"
  icons/                      gerados com `tauri icon`
  src/lib.rs                  plugins, comandos e montagem do app (ponto de extensão da 7b)
  src/token.rs                TokenVault + trait TokenStore (chaveiro com fallback em memória) e testes
  src/nav.rs                  guarda de navegação (links externos) e testes
```
