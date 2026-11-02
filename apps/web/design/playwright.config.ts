import { defineConfig, devices } from "@playwright/test";

// Captura de telas para a auditoria/repaginação (docs/design). NÃO faz parte do CI nem do `pnpm e2e`.
// Uso: veja o cabeçalho de capture.spec.ts. Navegador: o do Playwright; se a versão instalada for
// outra, aponte para um Chromium completo com CHROMIUM_PATH.
export default defineConfig({
  testDir: ".",
  testMatch: /(capture|design-system|a11y-check)\.spec\.ts/,
  outputDir: "./.results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 20 * 60_000,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:8090",
    actionTimeout: 6_000,
    navigationTimeout: 30_000,
    locale: "pt-BR",
    timezoneId: "America/Sao_Paulo",
    ...devices["Desktop Chrome"],
    permissions: ["microphone", "camera"],
    launchOptions: {
      executablePath: process.env.CHROMIUM_PATH || undefined,
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        "--auto-select-desktop-capture-source=Entire screen",
        `--unsafely-treat-insecure-origin-as-secure=${process.env.E2E_BASE_URL ?? "http://localhost:8090"}`,
      ],
    },
  },
});
