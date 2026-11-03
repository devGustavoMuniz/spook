import { type BrowserContext, expect, type Page, test } from "@playwright/test";

// Social (adicional): pedir e aceitar amizade, DM entre amigos sem servidor em comum, bloqueio (DM recusada sem
// revelar nada), convidar amigo para um servidor pela DM e chamada em DM tocando e sendo atendida/recusada.
// Três contas em contextos separados, contra o backend real. A chamada precisa de voz LIGADA no backend
// (LIVEKIT_URL/LIVEKIT_API_KEY/LIVEKIT_API_SECRET; valores de desenvolvimento servem, o toque não fala com o LiveKit)
// e pula sozinha sem ela (como no job `e2e` do CI). O backend do E2E sobe com SPOOK_AUTH_RATE_PER_MIN=1000.

const PASSWORD = "senha-forte-123";
const run = Date.now().toString(36);
type Who = "a" | "b" | "c";
const username = (who: Who) => `e2e_soc_${who}_${run}`.slice(0, 32);

const sessions: Partial<Record<Who, Awaited<ReturnType<BrowserContext["storageState"]>>>> = {};
const ids: Partial<Record<Who, string>> = {};

async function json<T>(res: Awaited<ReturnType<BrowserContext["request"]["get"]>>, status: number) {
  expect(res.status(), await res.text()).toBe(status);
  return (await res.json()) as T;
}

test.beforeAll(async ({ browser }) => {
  for (const who of ["a", "b", "c"] as const) {
    const ctx = await browser.newContext();
    const res = await json<{ user: { id: string } }>(
      await ctx.request.post("/api/auth/register", {
        data: {
          email: `e2e-soc-${who}-${run}@spook.dev`,
          username: username(who),
          password: PASSWORD,
        },
      }),
      201,
    );
    ids[who] = res.user.id;
    sessions[who] = await ctx.storageState();
    await ctx.close();
  }
});

async function open(browser: import("@playwright/test").Browser, who: Who, url: string) {
  const ctx = await browser.newContext({ storageState: sessions[who] });
  const page = await ctx.newPage();
  const ready = page.waitForEvent("websocket", (ws) => ws.url().includes("/api/gateway"));
  await page.goto(url);
  const ws = await ready;
  await ws.waitForEvent("framereceived", (f) => String(f.payload).includes('"READY"'));
  return { ctx, page };
}

/** Garante a amizade pela API (a UI do pedido e do aceite é testada no primeiro teste); idempotente. */
async function ensureFriends(
  from: BrowserContext,
  to: BrowserContext,
  toName: string,
  fromId: string,
  toId: string,
) {
  const state = await json<{ type: string }>(
    await from.request.get(`/api/users/${toId}/relationship`),
    200,
  );
  if (state.type === "friend") return;
  await json(await from.request.post("/api/users/me/friends", { data: { username: toName } }), 201);
  await json(await to.request.put(`/api/users/me/friends/${fromId}`), 200);
}

const tab = (page: Page, name: string | RegExp) => page.getByRole("tab", { name });

test("A pede amizade a B pela tela de Amigos e B aceita em tempo real", async ({ browser }) => {
  const a = await open(browser, "a", "/channels/@me/friends");
  const b = await open(browser, "b", "/channels/@me");

  await tab(a.page, /Adicionar amigo/).click();
  await a.page.getByLabel("Nome de usuário").fill(`@${username("b")}`);
  await a.page.getByRole("button", { name: /Enviar pedido/ }).click();
  await expect(a.page.getByText(`Pedido enviado para @${username("b")}.`)).toBeVisible();

  // B recebe o pedido sem recarregar: selo no Início e na lista de conversas.
  await expect(b.page.getByRole("img", { name: "1 pedido de amizade" }).first()).toBeVisible();
  await b.page.getByRole("link", { name: /Amigos/ }).click();
  await tab(b.page, /Pendentes/).click();
  const pending = b.page.getByRole("list", { name: /Pedidos pendentes/ });
  await expect(pending.getByText(username("a"), { exact: false }).first()).toBeVisible();
  await pending.getByRole("button", { name: "Aceitar" }).click();
  await expect(b.page.getByText(`Você e @${username("a")} agora são amigos.`)).toBeVisible();

  // A vê B na lista de amigos (e online: os dois estão conectados, sem servidor em comum).
  await tab(a.page, "Todos").click();
  const all = a.page.getByRole("list", { name: /Todos os amigos/ });
  await expect(all.getByText(username("b"), { exact: false }).first()).toBeVisible();
  await tab(a.page, "Online").click();
  await expect(
    a.page
      .getByRole("list", { name: /Amigos online/ })
      .getByText(username("b"), { exact: false })
      .first(),
  ).toBeVisible();
  await a.ctx.close();
  await b.ctx.close();
});

test("amigos conversam sem servidor em comum; ao bloquear, a DM nova é recusada sem revelar o bloqueio", async ({
  browser,
}) => {
  const pa = await browser.newContext({ storageState: sessions.a });
  const pb = await browser.newContext({ storageState: sessions.b });
  await ensureFriends(pa, pb, username("b"), ids.a as string, ids.b as string);
  await pa.close();
  await pb.close();
  const a = await open(browser, "a", "/channels/@me/friends");
  const b = await open(browser, "b", "/channels/@me");
  await tab(a.page, "Todos").click();

  // A abre a DM com B pelo botão de mensagem; B recebe a conversa.
  await a.page.getByRole("button", { name: `Enviar mensagem para ${username("b")}` }).click();
  await expect(a.page).toHaveURL(/\/channels\/@me\/\d+$/);
  const dmId = a.page.url().split("/").pop() as string;
  await a.page.getByLabel(`Mensagem para ${username("b")}`).fill("oi, amigo");
  await a.page.getByLabel(`Mensagem para ${username("b")}`).press("Enter");
  await b.page.goto(`/channels/@me/${dmId}`);
  await expect(
    b.page.getByRole("log", { name: `Mensagens de ${username("a")}` }).getByText("oi, amigo"),
  ).toBeVisible();

  // A bloqueia B (menu da tela de Amigos + confirmação).
  await a.page.goto("/channels/@me/friends");
  await tab(a.page, "Todos").click();
  await a.page.getByRole("button", { name: `Mais opções de ${username("b")}` }).click();
  await a.page.getByRole("menuitem", { name: /Bloquear/ }).click();
  await a.page.getByRole("alertdialog").getByRole("button", { name: "Bloquear" }).click();
  await expect(a.page.getByText(`${username("b")} foi bloqueado.`)).toBeVisible();
  await tab(a.page, "Bloqueados").click();
  await expect(
    a.page
      .getByRole("list", { name: /Bloqueados/ })
      .getByText(username("b"), { exact: false })
      .first(),
  ).toBeVisible();

  // B: a amizade some em tempo real e a DM nova/mensagem nova são recusadas com erro genérico.
  const sent = await b.ctx.request.post(`/api/channels/${dmId}/messages`, {
    data: { content: "oi?" },
  });
  expect(sent.status()).toBe(403);
  expect((await sent.text()).toLowerCase()).not.toContain("bloque");
  const reopen = await b.ctx.request.post("/api/users/@me/channels", {
    data: { recipient_id: ids.a },
  });
  expect(reopen.status()).toBe(403);
  expect((await reopen.text()).toLowerCase()).not.toContain("bloque");
  // A, ao desbloquear, não restaura a amizade (o toast do bloqueio cobre as abas por alguns segundos: a aba
  // Bloqueados já está aberta).
  await a.page.getByRole("button", { name: "Desbloquear" }).click();
  await expect(a.page.getByText(`${username("b")} foi desbloqueado.`)).toBeVisible();
  await a.ctx.close();
  await b.ctx.close();
});

test("convidar amigo para um servidor pela DM mostra o cartão de convite", async ({ browser }) => {
  const owner = await browser.newContext({ storageState: sessions.c });
  const guest = await browser.newContext({ storageState: sessions.a });
  await ensureFriends(owner, guest, username("a"), ids.c as string, ids.a as string);
  const g = await json<{ id: string; name: string }>(
    await owner.request.post("/api/guilds", { data: { name: "Clube do Convite" } }),
    201,
  );
  await owner.close();
  await guest.close();

  const c = await open(browser, "c", "/channels/@me/friends");
  const a = await open(browser, "a", "/channels/@me");
  await tab(c.page, "Todos").click();
  await c.page.getByRole("button", { name: `Mais opções de ${username("a")}` }).click();
  await c.page.getByRole("menuitem", { name: /Convidar para servidor/ }).click();
  await c.page
    .getByRole("dialog", { name: "Convidar para servidor" })
    .getByRole("button", { name: /Clube do Convite/ })
    .click();
  await expect(
    c.page.getByText(`Convite para ${g.name} enviado a ${username("a")}.`),
  ).toBeVisible();

  // A recebe a conversa e o cartão de convite inline.
  await a.page
    .getByRole("navigation", { name: "Conversas" })
    .getByRole("link", { name: new RegExp(username("c")) })
    .click();
  await expect(a.page.getByText("Convite para um servidor")).toBeVisible();
  await expect(a.page.getByRole("button", { name: `Entrar em ${g.name}` })).toBeVisible();
  await c.ctx.close();
  await a.ctx.close();
});

test("chamada em DM: toca para o outro lado, recusa e atende", async ({ browser }) => {
  const ctxC = await browser.newContext({ storageState: sessions.c });
  const ctxA = await browser.newContext({ storageState: sessions.a });
  await ensureFriends(ctxC, ctxA, username("a"), ids.c as string, ids.a as string);
  await ctxA.close();
  const dm = await json<{ id: string }>(
    await ctxC.request.post("/api/users/@me/channels", { data: { recipient_id: ids.a } }),
    200,
  );
  const a = await open(browser, "a", `/channels/@me/${dm.id}`);

  // Toca: cartão com Atender/Recusar, foco em Atender. (O limite de ligações é de 5 de rajada: este teste usa 5.)
  const probe = await ctxC.request.post(`/api/channels/${dm.id}/call/ring`);
  test.skip(probe.status() === 503, "o backend está sem LiveKit configurado (voz desligada)");
  expect(probe.status(), await probe.text()).toBe(200);
  const dialog = a.page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(username("c"), { exact: false }).first()).toBeVisible();
  await expect(dialog.getByRole("button", { name: /Atender/ })).toBeFocused();
  await dialog.getByRole("button", { name: /Recusar/ }).click();
  await expect(dialog).toHaveCount(0);

  // A recusa acabou a chamada: dá para ligar de novo; Esc também recusa.
  await json(await ctxC.request.post(`/api/channels/${dm.id}/call/ring`), 200);
  await expect(dialog).toBeVisible();
  await a.page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // Quem liga cancela: o toque some do outro lado.
  await json(await ctxC.request.post(`/api/channels/${dm.id}/call/ring`), 200);
  await expect(dialog).toBeVisible();
  expect((await ctxC.request.post(`/api/channels/${dm.id}/call/cancel`)).status()).toBe(204);
  await expect(dialog).toHaveCount(0);

  // Atender: o diálogo fecha e a chamada passa a "em andamento" (sem LiveKit real o cliente não conecta a mídia).
  await json(await ctxC.request.post(`/api/channels/${dm.id}/call/ring`), 200);
  await expect(dialog).toBeVisible();
  const accepted = a.page.waitForResponse((r) =>
    r.url().includes(`/api/channels/${dm.id}/call/accept`),
  );
  await dialog.getByRole("button", { name: /Atender/ }).click();
  expect((await accepted).status()).toBe(200);
  await expect(dialog).toHaveCount(0);
  const again = await ctxC.request.post(`/api/channels/${dm.id}/call/ring`);
  expect(again.status()).toBe(409); // já há uma chamada em andamento
  await a.ctx.close();
  await ctxC.close();
});

test("a tela de Amigos cabe em 390 px sem rolagem horizontal", async ({ browser }) => {
  const ctx = await browser.newContext({
    storageState: sessions.a,
    viewport: { width: 390, height: 844 },
  });
  const page = await ctx.newPage();
  await page.goto("/channels/@me/friends");
  await expect(page.getByRole("tab", { name: "Todos" })).toBeVisible();
  await page.getByRole("tab", { name: "Todos" }).click();
  await page.getByRole("tab", { name: /Adicionar amigo/ }).scrollIntoViewIfNeeded();
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(over).toBeLessThanOrEqual(0);
  await ctx.close();
});
