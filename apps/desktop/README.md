# @spook/desktop

Casca **Tauri 2** do Spook. A interface é o [`apps/web`](../web) buildado em modo desktop; o Rust (`src-tauri`) só traz as
capacidades nativas: chaveiro do SO para o token, instância única, notificações do sistema, estado da janela e links
externos no navegador, e a **voz, o vídeo e a tela nativos** (Rust + LiveKit SDK, sem WebRTC no WebView). Decisões em
`SPEC.md` seção 5.5 (Fases 7a e 7b).

## Pré-requisitos

- Node 24 e pnpm (`pnpm install` na raiz).
- [Rust estável](https://rustup.rs) e as dependências do Tauri para o seu sistema:
  - **macOS:** Xcode Command Line Tools.
  - **Windows:** Microsoft C++ Build Tools e WebView2 (já vem no Windows 11).
  - **Linux (Ubuntu 24.04+ / Debian 13+):** as do Tauri (`libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev libxdo-dev libdbus-1-dev patchelf build-essential curl wget file`)
    **mais** as da voz nativa: `libasound2-dev libpipewire-0.3-dev libspa-0.2-dev libgbm-dev libdrm-dev libv4l-dev libx11-dev libxext-dev libxrandr-dev libxdamage-dev libxfixes-dev libxcomposite-dev libxtst-dev libxcb1-dev libxcb-shm0-dev libxcb-xfixes0-dev libxcb-shape0-dev libxcb-randr0-dev protobuf-compiler`.
    O libwebrtc exige **clang >= 21** (o do Ubuntu 24.04 é o 18): instale o LLVM 21 do [apt.llvm.org](https://apt.llvm.org) (`clang-21 libclang-21-dev`) e exporte `CC=clang-21 CXX=clang++-21 LIBCLANG_PATH=/usr/lib/llvm-21/lib`. O passo a passo exato está em `.github/workflows/desktop.yml`.
    Não funciona na 22.04: o `pipewire-rs` (usado pelo `scap`) pede libspa mais novo do que o da 22.04.
  - **Windows/macOS:** o MSVC + LLVM do Windows e o Xcode CLT do macOS bastam. O macOS precisa ser 12.3 ou mais novo (ScreenCaptureKit).

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

Testes e lint do Rust (a partir de `src-tauri`): `cargo test --lib`, `cargo clippy --all-targets -- -D warnings`, `cargo fmt --check`.
O `@spook/desktop` fica fora do Turborepo (`pnpm build`/`dev`/`verify.sh`) para o CI de código não compilar Rust.
A 1ª compilação baixa o libwebrtc pré-compilado (~100 MB) e leva vários minutos.

Sem a câmera nativa (a parte mais frágil da build): `cargo build --no-default-features` (feature Cargo `camera`, ligada por padrão).

### Rust sem instalar nada (Docker, espelha o runner Linux)

Usado na Fase 7b porque a máquina de desenvolvimento não tinha Rust. Imagem `ubuntu:24.04` com os pacotes dos passos "Dependências
do sistema (Linux)" e "Clang 21 (Linux)" de `desktop.yml` e o Rust (`rustup`, com `clippy` e `rustfmt`). Depois:

```sh
mkdir -p apps/web/dist-desktop && echo '<html></html>' > apps/web/dist-desktop/index.html   # o tauri-build exige a pasta (ignorada pelo git)
docker run --rm -v "$PWD":/work -w /work/apps/desktop/src-tauri \
  -v spook-cargo-target:/cache/target -e CARGO_TARGET_DIR=/cache/target spook-rust-dev cargo test --lib
```

### Teste de integração contra o LiveKit de dev

`src-tauri/tests/livekit_integration.rs` (todos `#[ignore]`) roda **sem placa de som, câmera nem tela**: o núcleo troca microfone, câmera e
tela por um tom de 440 Hz e barras de cor (`VoiceCore::use_synthetic_inputs`, só usado nos testes) e confere, contra o LiveKit de
desenvolvimento, que (1) o núcleo publica e outro participante do SDK recebe o tom e JPEGs com a resolução e as cores certas; (2) um
participante publica e o núcleo entrega o áudio ao mixer e JPEGs no canal binário, com ensurdecer, backpressure e desinscrição;
(3) mute/unmute, `disconnect` idempotente, um canal por vez e erros tipados (token inválido).

```sh
pnpm infra:up                                   # sobe o LiveKit (ws://localhost:7880) na rede spook_default
# no Linux: direto
cd apps/desktop/src-tauri && cargo test --test livekit_integration -- --ignored --test-threads=1
# no Docker, na rede do Compose (a imagem acima):
docker run --rm --network spook_default -e LIVEKIT_URL=ws://livekit:7880 -v "$PWD":/work -w /work/apps/desktop/src-tauri \
  -v spook-cargo-target:/cache/target -e CARGO_TARGET_DIR=/cache/target spook-rust-dev \
  cargo test --test livekit_integration -- --ignored --test-threads=1
```

`LIVEKIT_URL`, `LIVEKIT_API_KEY` e `LIVEKIT_API_SECRET` mudam o alvo (padrões: `ws://localhost:7880`, `devkey` e o segredo de dev de `deploy/livekit/livekit.yaml`).

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
| Linux x64 | `ubuntu-24.04` | `.deb` e `.AppImage` |

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
- No macOS o `Info.plist` (`src-tauri/Info.plist`) e os entitlements (`entitlements.plist`) declaram microfone, câmera e
  gravação de tela. A permissão de **Gravação de Tela e Áudio do Sistema** é por identidade do binário (TCC): depois de permitir, feche e
  abra o Spook; como a assinatura é *ad-hoc*, o macOS pode pedir de novo a cada build/instalação nova (remova o Spook da lista e adicione
  de novo, ou `tccutil reset ScreenCapture com.dottadigital.spook`).
- O plugin de notificação do desktop não tem callback de clique; o Spook usa uma heurística de foco para abrir o canal certo (veja "Casca do app").

## Voz, vídeo e tela nativos (Fase 7b)

**Eco, ruído e ganho.** O `NativeAudioSource` do LiveKit não passa pelo APM do WebRTC, então `src-tauri/src/voice/apm.rs` faz a ponte à
mão com o `AudioProcessingModule` do libwebrtc: o que tocamos (mixer, 48 kHz mono, 10 ms) vai como *far-end* e cada quadro do microfone
passa por `process_stream` antes de ir ao LiveKit. Padrão: **AEC + redução de ruído (Padrão) + AGC ligados**. Em "Dispositivos de áudio e vídeo" há eco, ganho e um seletor de ruído com
três níveis (`voice_set_audio_processing({ echoCancellation, noiseSuppression: "off" | "standard" | "strong", autoGainControl })`; o
booleano antigo ainda é aceito): *Desligada*, *Padrão* (NS do APM do libwebrtc) e *Forte* (RNNoise nativo, `src-tauri/src/voice/rnnoise.rs`,
com o NS do APM desligado). Ordem: AEC, depois NS/AGC do APM, depois RNNoise, antes do `NativeAudioSource`. Mudar AEC, AGC ou Padrão recria o
módulo (reconverge em ~1 s); ligar/desligar o Forte não, e tem crossfade de 10 ms. A dica de atraso do AEC é estimada a cada ~1 s pelos
timestamps do cpal (`voice/delay.rs`; mediana de 5 medições, entre 10 e 400 ms, 60 ms sem timestamps).
Testes sem hardware: `cargo test --lib apm::`, `rnnoise::`, `delay::` (o módulo `rnnoise` e o `delay` são puros).
**Licenças:** o Forte usa a crate `nnnoiseless` 0.5.2 (BSD-3-Clause, port em Rust puro do RNNoise do Xiph.Org; sem dependência nativa).

Nada de WebRTC no WebView (RF12.2): o núcleo em `src-tauri/src/voice/` usa o LiveKit Rust SDK (libwebrtc), `cpal` (microfone e
alto-falante), `scap` (tela e janela) e `nokhwa` (câmera). A interface fala com ele por comandos e canais do Tauri
(`apps/web/src/desktop/native-engine.ts` implementa a mesma interface `VoiceEngine` da engine web). Resumo da API em `SPEC.md` (Fase 7b).

- **Vídeo remoto:** vira JPEG (no máx. 1280x720, ~15 fps) e viaja em canal binário, desenhado num `<canvas>`; quadros são descartados se o
  webview atrasar (créditos `voice_video_ack`) e a conversão para quando ninguém está desenhando.
- **Tela:** envia no máx. 1080p a 15 fps. Linux: o seletor é o do próprio sistema (portal xdg + PipeWire, funciona em Wayland e X11 com
  `xdg-desktop-portal`). macOS: 12.3+ e permissão de gravação de tela. Windows: Windows Graphics Capture.
- **Limitações conhecidas:** sem **áudio do sistema** ao compartilhar a tela (o diálogo avisa que só a imagem vai; por isso também não há eco por compartilhamento); a qualidade do cancelamento de eco depende do atraso e do volume do alto-falante (veja abaixo); a câmera depende do
  `nokhwa` (desligável); o `scap` só para a captura no próximo quadro se a tela estiver totalmente parada; os dispositivos de áudio não são
  atualizados ao plugar/desplugar durante a chamada (reabra o diálogo); o `.deb`/AppImage pedem glibc >= 2.39 (build em Ubuntu 24.04) e
  `libasound2`, `libpipewire-0.3-0`, `libgbm1`, `libdrm2` e `libdbus-1-3` instalados.

## Volume por pessoa, porta de ruído, teste de microfone e qualidade da tela (desktop)

Contrato definido pelo web (`apps/web/src/features/voice/engine.ts`); resumo da API Rust↔web:

| Comando / evento | O que faz |
| --- | --- |
| `voice_set_participant_volume({ identity, source: "voice" \| "screen", volume })` | Ganho local por pessoa e origem, 0 a 2,0 (200%; `0` = silenciada só para mim). Vive no mixer (`voice/mixer.rs`): soma com saturação e rampa linear de 10 ms (sem estalo). Vale para as faixas de agora e as que a pessoa republicar, enquanto ela estiver na sala (o web reenvia ao entrar). O áudio da tela é a faixa `ScreenshareAudio` (hoje o desktop não a publica, mas ouve a de quem publica). |
| `voice_set_audio_processing({ ..., inputSensitivity?: { mode: "off" \| "auto" \| "manual", thresholdDb } })` | Porta de ruído (`voice/gate.rs`, porta fiel do `gate-worklet.js`) DEPOIS do AEC/NS/RNNoise, em qualquer nível de supressão. Ausente = desligada (formato antigo continua válido). Desligada, o áudio passa intacto, sem atraso; ligada, adiciona 10 ms de lookahead. |
| `voice_set_input_level_monitor({ enabled, events? })` | Medidor de nível: evento `{ type: "input-level", db, gateOpen }` ~20x por segundo (dBFS depois da supressão e da porta). Fora de chamada abre uma captura de PRÉVIA do microfone (mesma cadeia, sem publicar, sem far-end); ao abrir o microfone na chamada a prévia cede e a captura da chamada alimenta o medidor; com o microfone mudo na chamada a prévia volta. |
| `voice_start_mic_test({ events? })` / `voice_cancel_mic_test()` | Grava ~5 s do microfone já processado (buffer fixo de 240 mil amostras) e toca no alto-falante escolhido; nunca toca o microfone ao vivo. Eventos `{ type: "mic-test", phase: "requesting" \| "recording" \| "playing" \| "done" \| "error", remainingMs?, error? }`. Com o microfone aberto na chamada o comando recusa com o erro tipado `media/in-use` (o web mostra o aviso). Cancelar emite `done`. |
| `voice_set_screen_share({ on, options: { sourceId, audio, quality?: { height, fps, priority, maxBitrateKbps? } } })` | Qualidade (`voice/quality.rs`): `height` 720/1080/1440, `fps` 15/30/60 (o limitador de quadros da tela passou a aceitar 60), `priority` `detail`/`motion` (vira `degradation_preference` do LiveKit: manter resolução ou manter fps), teto de bitrate igual à tabela de `screen-quality.ts` (1080p15 = 2,5 Mbps). Sem `quality`: 1080p, 15 fps, nitidez, como sempre foi. A captura (`scap`) roda em `fps` e o funil reduz o quadro para a caixa 16:9 da altura (nunca amplia). PiP segue indisponível. |

`events` é opcional porque o medidor e o teste valem FORA de chamada (não há canal da sala): o `native-engine.ts` cria um canal próprio e o
reutiliza. Testes sem hardware: `mixer`, `gate`, `quality` e `mictest` são módulos puros (`cargo test --lib mixer:: gate:: quality:: mictest::`).

## Casca do app: bandeja, início com o sistema, contador e clique na notificação

Código em `src-tauri/src/shell.rs` (cola com o Tauri) e `settings.rs`/`badge.rs` (lógica pura, testada).

- **Bandeja** (`tray-icon` do Tauri): ícone da marca, tooltip "Spook" (ou "Spook (3)" com não lidas), menu **Abrir Spook** e **Sair**; clique
  esquerdo alterna mostrar/ocultar a janela. **Sair** desconecta a voz (espera até 3 s) e encerra de fato; Cmd+Q/último fechamento também.
  Abrir o app uma segunda vez traz a janela de volta (instância única); no macOS, clicar no Dock com a janela escondida também.
- **Fechar vai para a bandeja** (padrão LIGADO): a janela é escondida, a voz continua. Na primeira vez uma notificação avisa "O Spook continua
  rodando na bandeja" (uma só vez, guardado no mesmo arquivo de configurações).
- **Iniciar com o sistema** (`tauri-plugin-autostart`, padrão DESLIGADO) e **Iniciar minimizado** (padrão DESLIGADO). O item de início passa
  `--autostart`; "minimizado" só vale nessas aberturas (ou com `--minimized` na linha de comando, para testar): abrir o app pelo ícone mostra a
  janela sempre. A posição/tamanho da janela é restaurada, mas a visibilidade não.
- **Configurações** (`/settings/app`, só no desktop; link "Aplicativo" no cabeçalho das configurações): comandos `app_get_settings` e
  `app_set_settings({ settings: { closeToTray, startWithSystem, startMinimized } })`. Ficam em `app-settings.json` no diretório de
  configuração do app (nada sensível; o token continua no chaveiro). O autostart é aplicado antes de gravar: se o SO recusar, nada muda e a
  página mostra o erro.
- **Contador no ícone** (`app_set_badge({ count })`, com o mesmo número do título `(N) Spook`: menções + DMs não lidas; o web envia com debounce de 250 ms):

  | SO | O que aparece |
  | --- | --- |
  | macOS | Número no ícone do Dock (`set_badge_count`) e tooltip da barra de menus. |
  | Windows | Ícone sobreposto na barra de tarefas (círculo vermelho com o número, gerado em código; "99+" acima de 99) e tooltip da bandeja. |
  | Linux | Contador do lançador só onde o desktop oferece (Unity/Dash to Dock com libunity); o tooltip da bandeja não existe no AppIndicator, então o número vai no título do ícone onde o painel o mostra. Em geral, só o título da janela `(N) Spook`. |

- **Clicar na notificação abre o canal certo.** O plugin de notificação do desktop não entrega o clique. Heurística: `notifier.ts` guarda
  `{ url, at }` da última notificação nativa; quando a janela ganha foco (evento de foco da janela do Tauri) ou o Rust a traz à frente
  (evento `app://activated`: bandeja "Abrir", segunda instância, Dock) em até `NOTIFICATION_CLICK_WINDOW_MS` (10 s, constante em
  `apps/web/src/desktop/notifier.ts`) e ela ainda não foi usada, o app navega para o canal UMA vez e esquece a notificação.
  **Limitação:** um alt-tab para o Spook dentro desses 10 s também navega, mesmo sem clicar na notificação.
- **Linux:** o ícone depende de um host de StatusNotifier/AppIndicator. KDE, XFCE, Cinnamon e MATE têm; o **GNOME precisa da extensão
  "AppIndicator and KStatusNotifierItem Support"**. Sem ela o app esconde a janela e não há ícone para reabri-la: desligue "Fechar vai para a
  bandeja" ou abra o Spook de novo (a segunda instância traz a janela). No Linux o clique esquerdo no ícone não chega ao app (limitação do
  AppIndicator): use o menu. O `.deb` depende de `libayatana-appindicator3-1 | libappindicator3-1`; no build, `libayatana-appindicator3-dev`.

## Estrutura

```
src-tauri/
  Cargo.toml  build.rs  tauri.conf.json  Info.plist  entitlements.plist
  capabilities/default.json   permissões mínimas da janela "main"
  icons/                      gerados com `tauri icon`
  src/lib.rs                  plugins, comandos e montagem do app
  src/token.rs                TokenVault + trait TokenStore (chaveiro com fallback em memória) e testes
  src/nav.rs                  guarda de navegação (links externos) e testes
  src/shell.rs                bandeja, fechar para a bandeja, autostart, contador no ícone, sair (voz desconectada)
  src/settings.rs  src/badge.rs   configurações em JSON e ícone/rótulo do contador (puros, testados)
  src/voice/                  voz, vídeo e tela nativos (core, commands, audio, screen, camera, mixer, gate, quality, mictest, router, frames, wire…)
  tests/livekit_integration.rs  integração (#[ignore]) contra o LiveKit de dev
```
