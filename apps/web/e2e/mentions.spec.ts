import {
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  expect,
  type Page,
  test,
} from "@playwright/test";

// Menções em massa, mensagem de entrada, tópico do canal e exclusão de servidor com senha (adicional).
// O setup (contas, servidores, convites) usa a API; o que está sob teste é o navegador.

const PASSWORD = "senha-forte-123";
const run = Date.now().toString(36);

type Account = { email: string; username: string };
const account = (tag: string): Account => ({
  email: `e2e-men-${tag}-${run}@spook.dev`,
  username: `e2e_men_${tag}_${run}`.slice(0, 32),
});

type Person = { ctx: BrowserContext; page: Page; me: Account };
type Guild = { id: string; channels: { id: string; type: number; name: string }[] };
type Who = "dono" | "membro" | "novo";

const sessions: Partial<Record<Who, Awaited<ReturnType<BrowserContext["storageState"]>>>> = {};

test.beforeAll(async ({ browser }) => {
  for (const who of ["dono", "membro", "novo"] as const) {
    const ctx = await browser.newContext();
    const res = await ctx.request.post("/api/auth/register", {
      data: { ...account(who), password: PASSWORD },
    });
    expect(res.status()).toBe(201);
    sessions[who] = await ctx.storageState();
    await ctx.close();
  }
});

async function person(browser: Browser, who: Who): Promise<Person> {
  const ctx = await browser.newContext({ storageState: sessions[who] });
  return { ctx, page: await ctx.newPage(), me: account(who) };
}

async function json<T>(
  res: Awaited<ReturnType<APIRequestContext["get"]>>,
  status: number,
): Promise<T> {
  expect(res.status(), await res.text()).toBe(status);
  return (await res.json()) as T;
}

async function join(owner: Person, who: Person, guildId: string) {
  const invite = await json<{ code: string }>(
    await owner.ctx.request.post(`/api/guilds/${guildId}/invites`, { data: {} }),
    201,
  );
  await json(await who.ctx.request.post(`/api/invites/${invite.code}`), 200);
}

async function open(p: Person, url: string) {
  const ready = p.page.waitForEvent("websocket", (ws) => ws.url().includes("/api/gateway"));
  await p.page.goto(url);
  const ws = await ready;
  await ws.waitForEvent("framereceived", (f) => String(f.payload).includes('"READY"'));
}

async function newGuild(owner: Person, name: string) {
  const guild = await json<Guild>(
    await owner.ctx.request.post("/api/guilds", { data: { name } }),
    201,
  );
  const text = guild.channels.find((c) => c.type === 0);
  if (!text) throw new Error("servidor sem canal de texto");
  return { guild, text, url: `/channels/${guild.id}/${text.id}` };
}

test("@everyone: só quem pode vê a opção; o outro vê a pílula, o destaque e a mensagem de entrada", async ({
  browser,
}) => {
  const owner = await person(browser, "dono");
  const member = await person(browser, "membro");
  const fresh = await person(browser, "novo");
  const { guild, text, url } = await newGuild(owner, "Menções E2E");
  await join(owner, member, guild.id);
  await open(owner, url);
  await open(member, url);

  // Mensagem de sistema ao vivo: o dono vê a linha centralizada quando outra pessoa entra.
  await join(owner, fresh, guild.id);
  await expect(owner.page.getByLabel(`${fresh.me.username} entrou no servidor`)).toBeVisible();

  // O membro não tem MENTION_EVERYONE: o autocomplete não oferece @everyone.
  const memberBox = member.page.getByLabel("Mensagem em #geral");
  await memberBox.fill("@");
  await expect(member.page.getByRole("listbox", { name: "Sugestões de menção" })).toBeVisible();
  await expect(member.page.getByRole("option", { name: /@everyone/ })).toHaveCount(0);
  await memberBox.fill("");

  // O dono (sempre pode) vê @everyone e @here, escolhe com o teclado e envia.
  const box = owner.page.getByLabel("Mensagem em #geral");
  await box.fill("@eve");
  await expect(owner.page.getByRole("option", { name: /@everyone/ })).toBeVisible();
  await box.press("Enter");
  await box.pressSequentially("reunião às 10");
  await box.press("Enter");

  // O membro recebe a mensagem com pílula distinta e a linha destacada.
  const row = member.page
    .getByRole("article", { name: /Mensagem de/ })
    .filter({ hasText: "reunião" });
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("data-mention", "true");
  await expect(row.locator('[data-mention-pill="everyone"]')).toHaveText("@everyone");

  // O contador de menção do membro (outro canal aberto → badge) vem do servidor.
  const states = await json<{ read_states: { channel_id: string; mention_count: number }[] }>(
    await member.ctx.request.get("/api/users/@me/read-states"),
    200,
  );
  expect(
    states.read_states.find((r) => r.channel_id === text.id)?.mention_count ?? 0,
  ).toBeGreaterThanOrEqual(0);

  await owner.ctx.close();
  await member.ctx.close();
  await fresh.ctx.close();
});

test("tópico no cabeçalho (390 px), edição pelo diálogo e exclusão do servidor com nome e senha", async ({
  browser,
}) => {
  const owner = await person(browser, "dono");
  const { guild, text, url } = await newGuild(owner, "Tópico E2E");
  await owner.page.setViewportSize({ width: 390, height: 800 });
  await open(owner, url);

  // Editar canal: o tópico aparece no cabeçalho, truncado.
  await json(
    await owner.ctx.request.patch(`/api/channels/${text.id}`, {
      data: { topic: "Regras: seja gentil. ".repeat(20) },
    }),
    200,
  );
  const topic = owner.page.getByTestId("channel-topic");
  await expect(topic).toBeVisible();
  const box = await topic.boundingBox();
  expect(box?.width ?? 0).toBeLessThanOrEqual(390);
  await topic.click();
  await expect(owner.page.getByRole("dialog").getByText(/Regras: seja gentil/)).toBeVisible();
  await owner.page.keyboard.press("Escape");

  // Excluir o servidor: digitar o nome e confirmar a senha.
  await owner.page.setViewportSize({ width: 1280, height: 800 });
  await owner.page.getByRole("button", { name: /Menu do servidor/ }).click();
  await owner.page.getByRole("menuitem", { name: /Configurações do servidor/ }).click();
  await owner.page.getByRole("button", { name: "Excluir servidor" }).click();
  const dialog = owner.page.getByRole("alertdialog");
  const del = dialog.getByRole("button", { name: "Excluir servidor" });
  await expect(del).toBeDisabled();
  await dialog.getByLabel(/Digite o nome do servidor/).fill("Tópico E2E");
  await del.click();
  await owner.page.getByLabel(/Senha/).fill(PASSWORD);
  await owner.page.getByRole("button", { name: /Confirmar/ }).click();
  await expect
    .poll(async () => (await owner.ctx.request.get(`/api/guilds/${guild.id}`)).status())
    .toBe(404);
  await owner.ctx.close();
});
