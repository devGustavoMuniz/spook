import {
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  expect,
  type Page,
  test,
} from "@playwright/test";

// Tempo real (Fase 3, RNF07): duas contas em contextos separados, contra o backend real.
// O setup (contas, servidor, convite, cargos) usa a API; o que está sob teste é o navegador.

const PASSWORD = "senha-forte-123";
const VIEW_CHANNEL = 1 << 6;
const run = Date.now().toString(36);

type Account = { email: string; username: string };
const account = (tag: string): Account => ({
  email: `e2e-gw-${tag}-${run}@spook.dev`,
  username: `e2e_gw_${tag}_${run}`.slice(0, 32),
});

type Person = { ctx: BrowserContext; page: Page; frames: string[]; me: Account };

// O cadastro/login tem limite por IP (10 por minuto): as duas contas são criadas uma vez e a sessão
// (cookie) é reaproveitada, com um contexto novo por teste.
const sessions: Partial<Record<"a" | "b", Awaited<ReturnType<BrowserContext["storageState"]>>>> =
  {};

test.beforeAll(async ({ browser }) => {
  for (const who of ["a", "b"] as const) {
    const ctx = await browser.newContext();
    const res = await ctx.request.post("/api/auth/register", {
      data: { ...account(who), password: PASSWORD },
    });
    expect(res.status()).toBe(201);
    sessions[who] = await ctx.storageState();
    await ctx.close();
  }
});

/** Contexto novo, já com sessão e com os frames recebidos do gateway guardados. */
async function person(browser: Browser, who: "a" | "b"): Promise<Person> {
  const ctx = await browser.newContext({ storageState: sessions[who] });
  const page = await ctx.newPage();
  const frames: string[] = [];
  page.on("websocket", (ws) => {
    if (!ws.url().includes("/api/gateway")) return;
    ws.on("framereceived", (f) => frames.push(String(f.payload)));
  });
  return { ctx, page, frames, me: account(who) };
}

async function json<T>(
  res: Awaited<ReturnType<APIRequestContext["get"]>>,
  status: number,
): Promise<T> {
  expect(res.status(), await res.text()).toBe(status);
  return (await res.json()) as T;
}

type Guild = { id: string; channels: { id: string; type: number; name: string }[] };

/** A cria um servidor, convida B e devolve ids. */
async function sharedGuild(a: Person, b: Person) {
  const guild = await json<Guild>(
    await a.ctx.request.post("/api/guilds", { data: { name: "Servidor RT" } }),
    201,
  );
  const invite = await json<{ code: string }>(
    await a.ctx.request.post(`/api/guilds/${guild.id}/invites`, { data: {} }),
    201,
  );
  await json(await b.ctx.request.post(`/api/invites/${invite.code}`), 200);
  const channel = guild.channels.find((c) => c.type === 0);
  if (!channel) throw new Error("servidor sem canal de texto");
  return { guildId: guild.id, channelId: channel.id, url: `/channels/${guild.id}/${channel.id}` };
}

/** Abre o canal e espera o READY: a partir daí o gateway já assinou os tópicos da pessoa. */
async function openChannel(p: Person, url: string) {
  const ready = p.page.waitForEvent("websocket", (ws) => ws.url().includes("/api/gateway"));
  await p.page.goto(url);
  const ws = await ready;
  await ws.waitForEvent("framereceived", (f) => String(f.payload).includes('"READY"'));
  await expect(p.page.getByRole("log", { name: "Mensagens de geral" })).toBeVisible();
  // marca a página: se algo recarregar, a marca some
  await p.page.evaluate(() => {
    (window as unknown as { __noReload: boolean }).__noReload = true;
  });
}

const notReloaded = (p: Person) =>
  p.page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload === true);

const messages = (p: Person) => p.page.getByRole("log", { name: "Mensagens de geral" });

async function say(from: Person, channelId: string, content: string) {
  await json(
    await from.ctx.request.post(`/api/channels/${channelId}/messages`, { data: { content } }),
    201,
  );
}

test("mensagem enviada por A aparece para B sem recarregar", async ({ browser }) => {
  const a = await person(browser, "a");
  const b = await person(browser, "b");
  const { url } = await sharedGuild(a, b);
  await openChannel(a, url);
  await openChannel(b, url);

  const composer = a.page.getByLabel("Mensagem em #geral");
  await composer.fill("olá em tempo real");
  await composer.press("Enter");

  await expect(messages(b).getByText("olá em tempo real")).toBeVisible();
  // A vê a própria mensagem uma vez só (resposta do POST + evento do gateway)
  await expect(messages(a).getByText("olá em tempo real")).toHaveCount(1);
  expect(await notReloaded(b)).toBe(true);

  await a.ctx.close();
  await b.ctx.close();
});

test("B fica sem rede, A envia, B volta e recebe a mensagem perdida (resume) sem recarregar", async ({
  browser,
}) => {
  const a = await person(browser, "a");
  const b = await person(browser, "b");
  const { channelId, url } = await sharedGuild(a, b);
  await openChannel(a, url);
  await openChannel(b, url);
  const first = b.frames.length;
  expect(first).toBeGreaterThan(0);

  await b.ctx.setOffline(true);
  await say(a, channelId, "enviada com B offline");
  await expect(messages(a).getByText("enviada com B offline")).toBeVisible();
  await expect(messages(b).getByText("enviada com B offline")).toHaveCount(0);

  await b.ctx.setOffline(false);
  await expect(messages(b).getByText("enviada com B offline")).toBeVisible({ timeout: 20_000 });
  expect(await notReloaded(b)).toBe(true);
  // foi RESUME (sessão retomada), não um IDENTIFY novo
  expect(b.frames.some((f) => f.includes('"RESUMED"'))).toBe(true);
  expect(b.frames.filter((f) => f.includes('"READY"'))).toHaveLength(1);

  await a.ctx.close();
  await b.ctx.close();
});

test("sem VIEW_CHANNEL no meio da sessão, B para de receber e sai do canal", async ({
  browser,
}) => {
  const a = await person(browser, "a");
  const b = await person(browser, "b");
  const { guildId, channelId, url } = await sharedGuild(a, b);
  await openChannel(a, url);
  await openChannel(b, url);

  // controle positivo: antes de perder a permissão, B recebe
  await say(a, channelId, "antes de perder o acesso");
  await expect(messages(b).getByText("antes de perder o acesso")).toBeVisible();

  // A (dono) tira VIEW_CHANNEL do @everyone (o cargo @everyone tem o mesmo id do servidor)
  const roles = await json<{ id: string; permissions: number }[]>(
    await a.ctx.request.get(`/api/guilds/${guildId}/roles`),
    200,
  );
  const everyone = roles.find((r) => r.id === guildId);
  if (!everyone) throw new Error("@everyone não encontrado");
  await json(
    await a.ctx.request.patch(`/api/guilds/${guildId}/roles/${guildId}`, {
      data: { permissions: everyone.permissions & ~VIEW_CHANNEL },
    }),
    200,
  );

  // B é levado para fora do canal, com aviso
  await expect(b.page.getByText("Este canal não está mais disponível.")).toBeVisible();
  await expect(b.page).toHaveURL(new RegExp(`/channels/${guildId}$`));
  expect(await notReloaded(b)).toBe(true);

  // e deixa de receber: A manda outra mensagem e o gateway não a entrega a B
  const seen = b.frames.length;
  await say(a, channelId, "depois de perder o acesso");
  await expect(messages(a).getByText("depois de perder o acesso")).toBeVisible();
  await b.page.waitForTimeout(1_500);
  expect(b.frames.slice(seen).some((f) => f.includes("depois de perder o acesso"))).toBe(false);
  await expect(b.page.getByText("depois de perder o acesso")).toHaveCount(0);

  await a.ctx.close();
  await b.ctx.close();
});
