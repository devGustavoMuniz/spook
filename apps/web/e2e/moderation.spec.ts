import {
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  expect,
  type Page,
  test,
} from "@playwright/test";

// Moderação (adicional): banir e tentar reentrar, canal privado invisível, apelido e registro de auditoria.
// O setup (contas, servidores, convites) usa a API; o que está sob teste é o navegador.

const PASSWORD = "senha-forte-123";
const run = Date.now().toString(36);

type Account = { email: string; username: string };
const account = (tag: string): Account => ({
  email: `e2e-mod-${tag}-${run}@spook.dev`,
  username: `e2e_mod_${tag}_${run}`.slice(0, 32),
});

type Person = { ctx: BrowserContext; page: Page; me: Account };
type Guild = { id: string; channels: { id: string; type: number; name: string }[] };
type Who = "dono" | "membro";

// O cadastro tem limite por IP: as contas nascem uma vez e a sessão é reaproveitada (contexto novo por teste).
const sessions: Partial<Record<Who, Awaited<ReturnType<BrowserContext["storageState"]>>>> = {};
const ids: Partial<Record<Who, string>> = {};

test.beforeAll(async ({ browser }) => {
  for (const who of ["dono", "membro"] as const) {
    const ctx = await browser.newContext();
    const res = await ctx.request.post("/api/auth/register", {
      data: { ...account(who), password: PASSWORD },
    });
    expect(res.status()).toBe(201);
    ids[who] = ((await (await ctx.request.get("/api/users/me")).json()) as { id: string }).id;
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

/** O dono cria um servidor e o membro entra por convite. */
async function sharedGuild(owner: Person, member: Person, name: string) {
  const guild = await json<Guild>(
    await owner.ctx.request.post("/api/guilds", { data: { name } }),
    201,
  );
  const invite = await json<{ code: string }>(
    await owner.ctx.request.post(`/api/guilds/${guild.id}/invites`, { data: {} }),
    201,
  );
  await json(await member.ctx.request.post(`/api/invites/${invite.code}`), 200);
  const text = guild.channels.find((c) => c.type === 0);
  if (!text) throw new Error("servidor sem canal de texto");
  return { guild, text, inviteCode: invite.code, url: `/channels/${guild.id}/${text.id}` };
}

/** Abre o canal e espera o READY: a partir daí o gateway já assinou os tópicos da pessoa. */
async function open(p: Person, url: string) {
  const ready = p.page.waitForEvent("websocket", (ws) => ws.url().includes("/api/gateway"));
  await p.page.goto(url);
  const ws = await ready;
  await ws.waitForEvent("framereceived", (f) => String(f.payload).includes('"READY"'));
}

test("banir com motivo, tentar reentrar por convite, desbanir e ver tudo no registro de auditoria", async ({
  browser,
}) => {
  const owner = await person(browser, "dono");
  const member = await person(browser, "membro");
  const { guild, url, inviteCode } = await sharedGuild(owner, member, "Banimentos E2E");
  await open(owner, url);
  await open(member, url);

  // O dono bane o membro pela lista de membros, com motivo.
  const panel = owner.page.getByRole("complementary", { name: "Membros" });
  await panel.getByRole("button", { name: `Opções de ${member.me.username}` }).click();
  await owner.page.getByRole("menuitem", { name: "Banir" }).click();
  const dialog = owner.page.getByRole("alertdialog");
  await dialog.getByLabel("Motivo (opcional)").fill("spam de links");
  await dialog.getByRole("button", { name: "Banir" }).click();

  // O membro é tirado do servidor ao vivo (sem recarregar).
  await expect(
    member.page.getByText(/Servidor não encontrado|Bem-vindo|ainda não está/).first(),
  ).toBeVisible();
  await expect(member.page.getByRole("link", { name: "Banimentos E2E" })).toHaveCount(0);

  // Reentrada pelo convite: bloqueada com a explicação.
  await member.page.goto(`/invite/${inviteCode}`);
  await member.page.getByRole("button", { name: "Entrar no servidor" }).click();
  await expect(member.page.getByTestId("join-error")).toContainText("banido deste servidor");

  // Banimentos: lista com motivo; desbanir com confirmação.
  await owner.page.getByRole("button", { name: /Menu do servidor/ }).click();
  await owner.page.getByRole("menuitem", { name: "Banimentos" }).click();
  await expect(owner.page.getByText("Motivo: spam de links")).toBeVisible();
  await owner.page.getByRole("button", { name: `Desbanir ${member.me.username}` }).click();
  await owner.page.getByRole("alertdialog").getByRole("button", { name: "Desbanir" }).click();
  await expect(owner.page.getByText("Ninguém está banido deste servidor.")).toBeVisible();

  // Depois de desbanido, entra de novo.
  await member.page.getByRole("button", { name: "Entrar no servidor" }).click();
  await expect(member.page).toHaveURL(new RegExp(`/channels/${guild.id}`));

  // Auditoria: ban e unban, com autor e motivo.
  await owner.page.getByRole("tab", { name: "Auditoria" }).click();
  await expect(owner.page.getByText(/\sbaniu “/)).toBeVisible();
  await expect(owner.page.getByText("Motivo: spam de links").last()).toBeVisible();
  await expect(owner.page.getByText(/desbaniu “/)).toBeVisible();

  await owner.ctx.close();
  await member.ctx.close();
});

test("canal privado some para quem não foi liberado e volta ao liberar, ao vivo", async ({
  browser,
}) => {
  const owner = await person(browser, "dono");
  const member = await person(browser, "membro");
  const { guild, url } = await sharedGuild(owner, member, "Privado E2E");
  const secret = await json<{ id: string }>(
    await owner.ctx.request.post(`/api/guilds/${guild.id}/channels`, {
      data: { type: 0, name: "diretoria" },
    }),
    201,
  );
  await open(owner, url);
  await open(member, url);
  const link = (p: Person) =>
    p.page.getByRole("navigation", { name: "Canais" }).getByRole("link", { name: "diretoria" });
  await expect(link(member)).toBeVisible();

  // O dono torna o canal privado pelo editor de permissões.
  const nav = owner.page.getByRole("navigation", { name: "Canais" });
  await nav.getByRole("button", { name: "Opções de diretoria" }).click();
  await owner.page.getByRole("menuitem", { name: "Permissões" }).click();
  const editor = owner.page.getByRole("dialog", { name: /Permissões de diretoria/ });
  await editor.getByRole("switch", { name: "Canal privado" }).click();
  await editor.getByRole("button", { name: "Salvar alterações" }).click();
  await expect(owner.page.getByText("Permissões do canal salvas.")).toBeVisible();

  // O membro perde o canal na hora e a API o recusa; o dono continua vendo.
  await expect(link(member)).toHaveCount(0);
  const denied = await member.ctx.request.get(`/api/channels/${secret.id}/messages`);
  expect(denied.status()).toBe(403);
  expect((await owner.ctx.request.get(`/api/channels/${secret.id}/messages`)).status()).toBe(200);

  // Libera a pessoa: o canal reaparece sem recarregar.
  await editor.getByRole("combobox", { name: "Liberar pessoa" }).click();
  await owner.page.getByRole("option", { name: member.me.username }).click();
  await editor.getByRole("button", { name: "Salvar alterações" }).click();
  await expect(link(member)).toBeVisible();
  expect((await member.ctx.request.get(`/api/channels/${secret.id}/messages`)).status()).toBe(200);

  await owner.ctx.close();
  await member.ctx.close();
});

test("apelido por servidor aparece na lista de membros e nas mensagens", async ({ browser }) => {
  const owner = await person(browser, "dono");
  const member = await person(browser, "membro");
  const { text, url } = await sharedGuild(owner, member, "Apelidos E2E");
  await open(owner, url);
  await open(member, url);

  await member.page.getByRole("button", { name: /Menu do servidor/ }).click();
  await member.page.getByRole("menuitem", { name: "Alterar apelido" }).click();
  await member.page.getByRole("textbox", { name: "Apelido" }).fill("Fantasma");
  await member.page.getByRole("button", { name: "Salvar" }).click();

  // Ao vivo na lista de membros do dono.
  await expect(
    owner.page.getByRole("complementary", { name: "Membros" }).getByText("Fantasma"),
  ).toBeVisible();

  // E nas mensagens do canal.
  await json(
    await member.ctx.request.post(`/api/channels/${text.id}/messages`, {
      data: { content: "quem sou eu?" },
    }),
    201,
  );
  const log = owner.page.getByRole("log", { name: "Mensagens de geral" });
  await expect(log.getByText("quem sou eu?")).toBeVisible();
  await expect(log.getByText("Fantasma").first()).toBeVisible();

  await owner.ctx.close();
  await member.ctx.close();
});

test("registro de auditoria: filtro por ação e quem não tem permissão não vê a aba", async ({
  browser,
}) => {
  const owner = await person(browser, "dono");
  const member = await person(browser, "membro");
  const { guild, url } = await sharedGuild(owner, member, "Auditoria E2E");
  await json(
    await owner.ctx.request.post(`/api/guilds/${guild.id}/channels`, {
      data: { type: 0, name: "novidades" },
    }),
    201,
  );
  await json(
    await owner.ctx.request.post(`/api/guilds/${guild.id}/roles`, {
      data: { name: "veteranos", position: 1, permissions: 0 },
    }),
    201,
  );
  await open(owner, url);

  await owner.page.getByRole("button", { name: /Menu do servidor/ }).click();
  await owner.page.getByRole("menuitem", { name: "Registro de auditoria" }).click();
  await expect(owner.page.getByText(/criou o canal “novidades”/)).toBeVisible();
  await expect(owner.page.getByText(/criou o cargo “veteranos”/)).toBeVisible();

  await owner.page.getByRole("combobox", { name: "Filtrar por ação" }).click();
  await owner.page.getByRole("option", { name: "Cargo criado" }).click();
  await expect(owner.page.getByText(/criou o canal “novidades”/)).toHaveCount(0);
  await expect(owner.page.getByText(/criou o cargo “veteranos”/)).toBeVisible();

  // Sem VIEW_AUDIT_LOG: o item não existe e a API recusa.
  await open(member, url);
  await member.page.getByRole("button", { name: /Menu do servidor/ }).click();
  await expect(member.page.getByRole("menuitem", { name: "Registro de auditoria" })).toHaveCount(0);
  expect((await member.ctx.request.get(`/api/guilds/${guild.id}/audit-logs`)).status()).toBe(403);

  await owner.ctx.close();
  await member.ctx.close();
});

test("as telas de moderação cabem em 390 px sem rolagem horizontal", async ({ browser }) => {
  const owner = await person(browser, "dono");
  const member = await person(browser, "membro");
  const { guild, url } = await sharedGuild(owner, member, "Celular E2E");
  await json(
    await owner.ctx.request.post(`/api/guilds/${guild.id}/channels`, {
      data: { type: 0, name: "um-nome-de-canal-bem-comprido-para-testar-o-layout" },
    }),
    201,
  );
  await owner.page.setViewportSize({ width: 390, height: 844 });
  await open(owner, url);

  const overflow = async () =>
    owner.page.evaluate(() => {
      const dlg = document.querySelector('[role="dialog"]') as HTMLElement | null;
      return {
        page: document.documentElement.scrollWidth - window.innerWidth,
        dialog: dlg ? dlg.scrollWidth - dlg.clientWidth : 0,
      };
    });

  // Editor de permissões do canal.
  await owner.page.getByRole("button", { name: "Abrir menu de navegação" }).click();
  const opts = owner.page.getByRole("button", { name: /^Opções de um-nome-de-canal/ });
  await opts.first().focus(); // o botão só aparece no hover/foco
  await opts.first().click();
  await owner.page.getByRole("menuitem", { name: "Permissões" }).click();
  await expect(owner.page.getByRole("dialog", { name: /Permissões de/ })).toBeVisible();
  const editor = await overflow();
  expect(editor.page).toBeLessThanOrEqual(0);
  expect(editor.dialog).toBeLessThanOrEqual(0);
  await owner.page.keyboard.press("Escape");

  await owner.ctx.close();
  await member.ctx.close();
});
