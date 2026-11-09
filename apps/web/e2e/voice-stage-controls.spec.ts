import { type BrowserContext, expect, type Page, test } from "@playwright/test";

// Palco de compartilhamento (adicional ao SPEC, 5.5): B assiste a tela de A e (1) recolhe a faixa dos
// participantes pelo botão da borda de baixo, com a escolha lembrada; (2) os controles somem após ~3 s parado
// (fade + deslize; só fade com movimento reduzido), voltam com o mouse e ficam inertes enquanto ocultos;
// (3) em tela cheia o cursor some junto. Precisa de LiveKit (projeto `voice`, E2E_VOICE=1).

const PASSWORD = "senha-forte-123";
const run = Date.now().toString(36);
const name = (who: "a" | "b") => `e2e_stg_${who}_${run}`.slice(0, 32);

type Person = { ctx: BrowserContext; page: Page; username: string };
const people: Partial<Record<"a" | "b", Person>> = {};
let url = "";

test.beforeAll(async ({ browser }) => {
  for (const who of ["a", "b"] as const) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const reg = await ctx.request.post("/api/auth/register", {
      data: { email: `e2e-stg-${who}-${run}@spook.dev`, username: name(who), password: PASSWORD },
    });
    expect(reg.status()).toBe(201);
    people[who] = { ctx, page: await ctx.newPage(), username: name(who) };
  }
  const { a, b } = people as Record<"a" | "b", Person>;
  const guild = (await (
    await a.ctx.request.post("/api/guilds", { data: { name: "Palco" } })
  ).json()) as { id: string; channels: { id: string; type: number }[] };
  const invite = (await (
    await a.ctx.request.post(`/api/guilds/${guild.id}/invites`, { data: {} })
  ).json()) as { code: string };
  expect((await b.ctx.request.post(`/api/invites/${invite.code}`)).status()).toBe(200);
  url = `/channels/${guild.id}/${guild.channels.find((c) => c.type === 0)?.id}`;
});

test.afterAll(async () => {
  for (const p of Object.values(people)) await p?.ctx.close();
});

const dock = (p: Page) => p.getByRole("region", { name: "Controles de voz" });
const join = async (p: Page) => {
  await p
    .getByRole("navigation", { name: "Canais" })
    .getByRole("button", { name: /Geral \(canal de voz/ })
    .click();
  await expect(dock(p).getByText("Voz conectada")).toBeVisible({ timeout: 25_000 });
};

test("recolher participantes e auto-ocultar dos controles ao assistir uma tela", async () => {
  test.setTimeout(300_000);
  const { a, b } = people as Record<"a" | "b", Person>;
  await a.page.goto(url);
  await b.page.goto(url);
  await join(a.page);
  await join(b.page);
  await dock(a.page).getByRole("button", { name: "Compartilhar tela" }).click();
  await a.page.getByRole("button", { name: "Compartilhar", exact: true }).click();
  await b.page.getByRole("button", { name: /^Assistir tela de / }).click({ timeout: 25_000 });

  const page = b.page;
  const stage = page.getByRole("region", { name: "Vídeo da chamada" });
  const controls = page.getByTestId("stage-controls");
  const toggle = page.getByTestId("strip-toggle");
  const strip = page.getByTestId("participants-strip");
  const spotlight = page.getByRole("list", { name: "Em destaque" });
  await page.getByRole("button", { name: /^Destacar tela de / }).click({ timeout: 25_000 });
  await expect(spotlight).toBeVisible({ timeout: 20_000 });
  // Em máquina lenta os 3 s de ociosidade passam entre dois passos: o mouse "acorda" os controles antes de clicar.
  const wake = async () => {
    await page.mouse.move(500, 300);
    await page.mouse.move(520, 320);
  };

  // 1. Recolher: a faixa some (altura 0, inerte) e a tela em destaque cresce.
  await page.mouse.move(640, 300);
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const before = (await spotlight.boundingBox())?.height ?? 0;
  await wake();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toHaveAccessibleName("Mostrar participantes");
  await expect(strip).toHaveAttribute("inert", "");
  await expect.poll(async () => (await strip.boundingBox())?.height ?? 0).toBeLessThan(2);
  await expect
    .poll(async () => (await spotlight.boundingBox())?.height ?? 0)
    .toBeGreaterThan(before + 40);

  // A escolha vale na sessão: recarregar mantém recolhido (e a tela volta sozinha ao palco).
  await page.reload();
  await join(page);
  await page.getByRole("button", { name: /^Assistir tela de / }).click({ timeout: 25_000 });
  await page.getByRole("button", { name: /^Destacar tela de / }).click({ timeout: 25_000 });
  await expect(page.getByTestId("strip-toggle")).toHaveAttribute("aria-expanded", "false");
  await wake();
  await page.getByTestId("strip-toggle").click();
  await expect(page.getByTestId("strip-toggle")).toHaveAttribute("aria-expanded", "true");

  // 2. Auto-ocultar (tela em foco, fora da tela cheia): parado ~3 s, tudo some e fica inerte.
  await page.mouse.move(600, 300);
  await page.mouse.move(640, 320);
  await expect(controls).toHaveAttribute("data-visible", "true");
  await expect(controls).toHaveAttribute("data-visible", "false", { timeout: 6_000 });
  await expect(controls).toHaveAttribute("inert", "");
  await expect(controls).toHaveAttribute("aria-hidden", "true");
  await expect(controls).toHaveCSS("opacity", "0");
  await expect(toggle).toHaveCSS("opacity", "0");
  await expect(toggle).toHaveAttribute("inert", "");
  // Movimento traz de volta.
  await page.mouse.move(700, 340);
  await expect(controls).toHaveAttribute("data-visible", "true");
  await expect(controls).not.toHaveAttribute("inert", "");
  await expect(controls).toHaveCSS("opacity", "1");

  // Mouse sobre a barra: não some.
  const mic = controls.getByRole("button").first();
  await mic.hover();
  await page.waitForTimeout(3_800);
  await expect(controls).toHaveAttribute("data-visible", "true");

  // Teclado traz de volta e foco dentro segura.
  await page.mouse.move(640, 200);
  await expect(controls).toHaveAttribute("data-visible", "false", { timeout: 6_000 });
  await expect(async () => {
    await page.keyboard.press("Shift");
    await expect(controls).toHaveAttribute("data-visible", "true", { timeout: 1_500 });
  }).toPass({ timeout: 15_000 });

  // 3. Movimento reduzido: sem deslize, só fade.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.mouse.move(600, 150);
  await expect(controls).toHaveAttribute("data-visible", "false", { timeout: 6_000 });
  await expect(controls).toHaveCSS("transform", "none");
  await page.emulateMedia({ reducedMotion: "no-preference" });

  // 4. Tela cheia: o cursor some junto.
  await page.mouse.move(700, 300);
  await expect(controls).toHaveAttribute("data-visible", "true");
  await page.getByRole("button", { name: "Tela cheia do palco" }).click();
  await expect(stage).toHaveAttribute("data-fullscreen", "true");
  await page.mouse.move(720, 320);
  await expect(stage).toHaveAttribute("data-controls", "hidden", { timeout: 6_000 });
  await expect(stage).toHaveCSS("cursor", "none");
  await page.mouse.move(740, 340);
  await expect(stage).toHaveAttribute("data-controls", "visible");
  await wake();
  await page.getByRole("button", { name: "Sair da tela cheia" }).click();
  await expect(stage).not.toHaveAttribute("data-fullscreen", "true");

  await dock(a.page).getByRole("button", { name: "Parar de compartilhar a tela" }).click();
});
