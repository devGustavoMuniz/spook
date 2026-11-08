import { expect, type Locator, type Page, test } from "@playwright/test";

// Bug: o diálogo de configurações da chamada não rolava (o viewport do ScrollArea crescia até o conteúdo
// inteiro e o `overflow-hidden` só cortava). Aqui: o corpo rola por roda, teclado e barra, em alturas baixas
// e nos dois temas, e o último controle é alcançável. Precisa de LiveKit (projeto `voice`, E2E_VOICE=1).

const PASSWORD = "senha-forte-123";
const run = Date.now().toString(36);
const HEIGHTS = [500, 600, 700, 900];

const bodyOf = (dlg: Locator) => dlg.locator("[data-radix-scroll-area-viewport]");
const metrics = (body: Locator) =>
  body.evaluate((el) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    scrollTop: el.scrollTop,
  }));

async function setTheme(page: Page, theme: "light" | "dark") {
  await page.addInitScript((t) => localStorage.setItem("spook-theme", t), theme);
}

test("diálogo de configurações da chamada rola até o último controle (roda, teclado e barra)", async ({
  browser,
}) => {
  const ctx = await browser.newContext({ permissions: ["microphone", "camera"] });
  const reg = await ctx.request.post("/api/auth/register", {
    data: {
      email: `e2e-dscroll-${run}@spook.dev`,
      username: `e2e_dscroll_${run}`.slice(0, 32),
      password: PASSWORD,
    },
  });
  expect(reg.status()).toBe(201);
  const guild = (await (
    await ctx.request.post("/api/guilds", { data: { name: "Rolagem" } })
  ).json()) as { id: string; channels: { id: string; type: number }[] };
  const text = guild.channels.find((c) => c.type === 0);
  const page = await ctx.newPage();

  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    for (const height of HEIGHTS) {
      await page.setViewportSize({ width: 1280, height });
      await page.goto(`/channels/${guild.id}/${text?.id}`);
      await page
        .getByRole("navigation", { name: "Canais" })
        .getByRole("button", { name: /Geral \(canal de voz/ })
        .click();
      const dock = page.getByRole("region", { name: "Controles de voz" });
      await expect(dock.getByText("Voz conectada")).toBeVisible({ timeout: 25_000 });
      await dock
        .getByRole("button", { name: /dispositivos|configurações de áudio|Configurações de voz/i })
        .first()
        .click();
      const dlg = page.getByRole("dialog");
      await expect(dlg).toBeVisible();
      const body = bodyOf(dlg);
      await expect(page.locator("#audio-processing-autoGainControl")).toBeAttached();

      // 1. há o que rolar e o corpo é limitado pela altura da janela
      const m0 = await metrics(body);
      expect(m0.scrollHeight, `${theme} ${height}: scrollHeight`).toBeGreaterThan(m0.clientHeight);
      const box = await dlg.boundingBox();
      expect(box?.height ?? 0).toBeLessThanOrEqual(height);
      expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(height);

      // 2. roda do mouse
      await body.hover();
      await page.mouse.wheel(0, 400);
      await expect.poll(async () => (await metrics(body)).scrollTop).toBeGreaterThan(0);

      // 3. teclado: Tab até o último interruptor rola até ele (continua dentro do corpo)
      const lastSwitch = dlg.getByRole("switch").last();
      await body.evaluate((el) => {
        el.scrollTop = 0;
      });
      await dlg.getByRole("combobox").first().focus();
      for (let i = 0; i < 40; i++) {
        if (await lastSwitch.evaluate((el) => el === document.activeElement)) break;
        await page.keyboard.press("Tab");
      }
      await expect(lastSwitch).toBeFocused();
      const inside = await lastSwitch.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const b = el.closest("[data-radix-scroll-area-viewport]")?.getBoundingClientRect();
        return !!b && r.top >= b.top - 1 && r.bottom <= b.bottom + 1;
      });
      expect(inside, "último controle visível depois do Tab").toBe(true);

      // 4. arrastar a barra de rolagem até o fim e clicar no último controle
      await body.evaluate((el) => {
        el.scrollTop = 0;
      });
      const thumb = dlg
        .locator("[data-radix-scroll-area-thumb], [class*='bg-scroll-thumb']")
        .first();
      await expect(thumb).toBeVisible();
      const tb = await thumb.boundingBox();
      if (tb) {
        await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2);
        await page.mouse.down();
        await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2 + 2000, { steps: 8 });
        await page.mouse.up();
      }
      await expect
        .poll(async () => {
          const m = await metrics(body);
          return m.scrollHeight - m.clientHeight - m.scrollTop;
        })
        .toBeLessThan(2);
      const before = await lastSwitch.getAttribute("aria-checked");
      await lastSwitch.click();
      await expect(lastSwitch).not.toHaveAttribute("aria-checked", before ?? "");
      await lastSwitch.click();

      await page.keyboard.press("Escape");
      await expect(dlg).toBeHidden();
      await dock.getByRole("button", { name: "Sair da chamada" }).click();
    }
  }
  await ctx.close();
});
