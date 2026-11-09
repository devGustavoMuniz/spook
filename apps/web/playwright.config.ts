import { defineConfig, devices } from "@playwright/test";

// O E2E roda contra o build de produção do front servido pelo próprio backend
// (SPOOK_WEB_DIR=apps/web/dist), com Postgres real. Veja apps/web/README.md.
// Voz com mídia real (e2e/voice.spec.ts) precisa de um LiveKit alcançável pelo navegador; o CI não tem.
// Por isso é um projeto à parte, só com E2E_VOICE=1 (veja "Voz" em apps/web/README.md). Sem a variável,
// roda a suíte de sempre (que ignora voice.spec.ts), como no job `e2e` do CI.
const voice = process.env.E2E_VOICE === "1";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./e2e/test-results",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never", outputFolder: "e2e/report" }]]
    : [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:8090",
    locale: "pt-BR",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: voice
    ? [
        {
          name: "voice",
          testMatch:
            /voice(-join-perf|-dialog-scroll|-stream-stats|-stage-controls|-profile)?\.spec\.ts/,
          use: {
            ...devices["Desktop Chrome"],
            // Chromium completo (novo headless): o headless shell padrão ignora a flag de origem insegura abaixo.
            channel: "chromium",
            permissions: ["microphone", "camera"],
            launchOptions: {
              executablePath: process.env.CHROMIUM_PATH || undefined,
              args: [
                // Câmera e microfone falsos do Chromium (padrão de teste e bipe), sem diálogo de permissão.
                "--use-fake-device-for-media-stream",
                "--use-fake-ui-for-media-stream",
                // O front é servido por http://server:8090 (rede do Compose): não é "localhost", então o
                // Chromium trataria como inseguro e esconderia getUserMedia.
                `--unsafely-treat-insecure-origin-as-secure=${process.env.E2E_BASE_URL ?? "http://localhost:8090"}`,
              ],
            },
          },
        },
      ]
    : [
        {
          name: "chromium",
          testIgnore:
            /voice(-join-perf|-dialog-scroll|-stream-stats|-stage-controls|-profile)?\.spec\.ts/,
          use: {
            ...devices["Desktop Chrome"],
            launchOptions: { executablePath: process.env.CHROMIUM_PATH || undefined },
          },
        },
      ],
});
