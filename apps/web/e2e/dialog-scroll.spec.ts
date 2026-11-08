import { expect, type Page, test } from "@playwright/test";

// Diálogos com corpo longo (aqui: configurações do servidor e convites) rolam por roda e teclado em
// alturas baixas, nos dois temas. O caso do diálogo de voz está em voice-dialog-scroll.spec.ts.

const PASSWORD = "senha-forte-123";
const run = Date.now().toString(36);

async function box(page: Page) {
  return page
    .locator('[role="dialog"] [data-radix-scroll-area-viewport]')
    .first()
    .evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      scrollTop: el.scrollTop,
    }));
}

test("diálogo de configurações do servidor: corpo limitado pela janela e rolável", async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  const reg = await ctx.request.post("/api/auth/register", {
    data: {
      email: `e2e-dlgscroll-${run}@spook.dev`,
      username: `e2e_dlgscroll_${run}`.slice(0, 32),
      password: PASSWORD,
    },
  });
  expect(reg.status()).toBe(201);
  const guild = (await (
    await ctx.request.post("/api/guilds", { data: { name: "Diálogos" } })
  ).json()) as { id: string; channels: { id: string; type: number }[] };
  const text = guild.channels.find((c) => c.type === 0);
  const page = await ctx.newPage();

  for (const theme of ["light", "dark"] as const) {
    await page.addInitScript((t) => localStorage.setItem("spook-theme", t), theme);
    for (const height of [500, 600, 700, 900]) {
      await page.setViewportSize({ width: 1280, height });
      await page.goto(`/channels/${guild.id}/${text?.id}`);
      await page
        .getByRole("button", { name: /Diálogos/ })
        .first()
        .click();
      await page.getByRole("menuitem", { name: /Configurações do servidor/ }).click();
      const dlg = page.getByRole("dialog");
      await expect(dlg).toBeVisible();
      const b = await dlg.boundingBox();
      expect((b?.y ?? 0) + (b?.height ?? 0), `${theme} ${height}`).toBeLessThanOrEqual(height);
      await dlg
        .getByRole("tab", { name: /Convites/ })
        .click()
        .catch(() => undefined);
      const m = await box(page);
      // pode caber inteiro em janelas altas; quando não cabe, tem de rolar
      if (m.scrollHeight > m.clientHeight) {
        await page.locator('[role="dialog"] [data-radix-scroll-area-viewport]').first().hover();
        await page.mouse.wheel(0, 300);
        await expect.poll(async () => (await box(page)).scrollTop).toBeGreaterThan(0);
      }
      await page.keyboard.press("Escape");
      await expect(dlg).toBeHidden();
    }
  }
  await ctx.close();
});
