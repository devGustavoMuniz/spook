import { type BrowserContext, expect, type Page, test } from "@playwright/test";

// Perfil na chamada (adicional ao SPEC, 5.5): A troca nome e avatar (GIF animado) com B na mesma chamada; B vê o
// nome novo e o avatar na lista de conectados SEM recarregar. O GIF fica parado (canvas) e só anima enquanto a
// pessoa fala (mesmo sinal do anel verde; o microfone falso do Chromium apita). Projeto `voice` (E2E_VOICE=1).

const PASSWORD = "senha-forte-123";
const run = Date.now().toString(36);
const name = (who: "a" | "b") => `e2e_vpf_${who}_${run}`.slice(0, 32);
const NEW_NAME = `Voz Nova ${run}`.slice(0, 32);
const GIF = Buffer.from(
  "R0lGODlhIAAgAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAIAAgAAAINQABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFixgzatzIsaPHjyBDihxJsqTJkyhTqlzJUmRAACH5BAEKAAEALAAAAAAgACAAgQAA/wAAAAAAAAAAAAg1AAEIHEiwoMGDCBMqXMiwocOHECNKnEixosWLGDNq3Mixo8ePIEOKHEmypMmTKFOqXMlSZEAAOw==",
  "base64",
);

type Person = { ctx: BrowserContext; page: Page };
const people: Partial<Record<"a" | "b", Person>> = {};
let url = "";

test.beforeAll(async ({ browser }) => {
  for (const who of ["a", "b"] as const) {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 800 } });
    const reg = await ctx.request.post("/api/auth/register", {
      data: { email: `e2e-vpf-${who}-${run}@spook.dev`, username: name(who), password: PASSWORD },
    });
    expect(reg.status()).toBe(201);
    people[who] = { ctx, page: await ctx.newPage() };
  }
  const { a, b } = people as Record<"a" | "b", Person>;
  const guild = (await (
    await a.ctx.request.post("/api/guilds", { data: { name: "Perfil Voz" } })
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
const connected = (p: Page) =>
  p.getByRole("navigation", { name: "Canais" }).getByRole("list", { name: "Conectados" });

test("nome e avatar GIF mudam na chamada sem recarregar; o GIF só anima quando a pessoa fala", async () => {
  const { a, b } = people as Record<"a" | "b", Person>;
  await a.page.goto(url);
  await b.page.goto(url);
  await join(a.page);
  await join(b.page);
  await expect(connected(b.page).getByText(name("a"))).toBeVisible({ timeout: 20_000 });
  await b.page.evaluate(() => {
    (window as unknown as { __noReload: boolean }).__noReload = true;
  });

  const up = (await (
    await a.ctx.request.post("/api/users/me/avatar", {
      data: { content_type: "image/gif", size: GIF.length },
    })
  ).json()) as { upload_url: string; key: string };
  const put = await fetch(up.upload_url, {
    method: "PUT",
    headers: { "content-type": "image/gif" },
    body: GIF,
  });
  expect(put.ok).toBe(true);
  expect(
    (
      await a.ctx.request.patch("/api/users/me", {
        data: { display_name: NEW_NAME, avatar_key: up.key },
      })
    ).status(),
  ).toBe(200);

  // B e A: lista de conectados com o nome novo e o avatar (quadro parado no canvas).
  for (const p of [b.page, a.page]) {
    const list = connected(p);
    await expect(list.getByText(NEW_NAME)).toBeVisible({ timeout: 15_000 });
    await expect(list.getByText(name("a"), { exact: true })).toHaveCount(0);
    await expect(list.locator("[data-gif-still] canvas").first()).toBeVisible({ timeout: 15_000 });
  }
  expect(
    await b.page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload),
  ).toBe(true);

  // O GIF vivo só existe enquanto A fala (apito do microfone falso): visto por B (remoto) e por A (local),
  // e some de novo quando para (nunca fica animado o tempo todo).
  for (const p of [b.page, a.page]) {
    const row = connected(p).locator("li", { hasText: NEW_NAME });
    const live = row.locator("img[data-gif-live]");
    await expect
      .poll(async () => live.count(), { timeout: 40_000, intervals: [100] })
      .toBeGreaterThan(0);
    await expect.poll(async () => live.count(), { timeout: 40_000, intervals: [100] }).toBe(0);
  }
});
