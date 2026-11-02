import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

// Capturas da página de referência `/dev/design-system` (só existe no servidor de desenvolvimento).
//
//   pnpm --filter @spook/web dev   (porta 5180)
//   DESIGN_BASE_URL=http://localhost:5180 pnpm --filter @spook/web exec playwright test -c design/playwright.config.ts design/design-system.spec.ts
//
// Saída: docs/design/design-system/NN-secao-tema.png (fica sempre em "design-system": não depende de DESIGN_OUT).

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "../../../docs/design/design-system");
const sections = [
  "cores",
  "tipografia",
  "raios-sombras",
  "botoes",
  "campos",
  "avatar",
  "feedback",
  "overlays",
  "navegacao",
  "carregando",
  "vazios",
  "movimento",
];

test.use({ baseURL: process.env.DESIGN_BASE_URL ?? "http://localhost:5180" });

for (const theme of ["claro", "escuro"] as const) {
  test(`design system (${theme})`, async ({ browser }) => {
    mkdirSync(outDir, { recursive: true });
    const ctx = await browser.newContext({
      viewport: { width: 1200, height: 900 },
      reducedMotion: "reduce",
    });
    await ctx.addInitScript(
      (t) => localStorage.setItem("spook-theme", t === "escuro" ? "dark" : "light"),
      theme,
    );
    const page = await ctx.newPage();
    await page.goto("/dev/design-system");
    await expect(page.getByRole("heading", { name: "Design system do Spook" })).toBeVisible();
    await page.waitForTimeout(600);

    for (const [i, id] of sections.entries()) {
      await page.locator(`#${id}`).screenshot({
        path: join(outDir, `${String(i + 1).padStart(2, "0")}-${id}-${theme}.png`),
      });
    }

    // overlays abertos
    const shot = (name: string) => page.screenshot({ path: join(outDir, `${name}-${theme}.png`) });
    await page.getByRole("button", { name: "Abrir diálogo" }).click();
    await page.waitForTimeout(300);
    await shot("13-dialogo");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Menu", exact: true }).click();
    await page.waitForTimeout(300);
    await shot("14-menu");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Sucesso" }).click();
    await page.waitForTimeout(500);
    await shot("15-toast");
    await ctx.close();
  });
}
