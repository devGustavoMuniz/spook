import {
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  expect,
  type Page,
  test,
} from "@playwright/test";

// Fase 4: DMs, presença e "digitando…" com três contas em contextos separados, contra o backend real.
// O backend do E2E sobe com SPOOK_PRESENCE_OFFLINE_GRACE=2s (padrão de produção: 15 s), para o
// offline não pesar na suíte. O que está sob teste é o navegador; o setup usa a API.

const PASSWORD = "senha-forte-123";
const run = Date.now().toString(36);

type Who = "a" | "b" | "c";
const username = (who: Who) => `e2e_dm_${who}_${run}`.slice(0, 32);

type Person = { ctx: BrowserContext; page: Page; frames: string[] };

// Cadastro tem limite por IP (10/min): as três contas são criadas uma vez e a sessão é reaproveitada.
const sessions: Partial<Record<Who, Awaited<ReturnType<BrowserContext["storageState"]>>>> = {};
const ids: Partial<Record<Who, string>> = {};
let guildUrl = "";

/** Abre (ou reabre) a DM 1:1: 201 se criou, 200 se já existia. */
async function ensureDm(ctx: BrowserContext, recipientId: string | undefined) {
  const res = await ctx.request.post("/api/users/@me/channels", {
    data: { recipient_id: recipientId },
  });
  expect([200, 201], await res.text()).toContain(res.status());
  return (await res.json()) as { id: string };
}

async function json<T>(
  res: Awaited<ReturnType<APIRequestContext["get"]>>,
  status: number,
): Promise<T> {
  expect(res.status(), await res.text()).toBe(status);
  return (await res.json()) as T;
}

test.beforeAll(async ({ browser }) => {
  const people: Partial<Record<Who, BrowserContext>> = {};
  for (const who of ["a", "b", "c"] as const) {
    const ctx = await browser.newContext();
    const res = await json<{ user: { id: string } }>(
      await ctx.request.post("/api/auth/register", {
        data: {
          email: `e2e-dm-${who}-${run}@spook.dev`,
          username: username(who),
          password: PASSWORD,
        },
      }),
      201,
    );
    ids[who] = res.user.id;
    sessions[who] = await ctx.storageState();
    people[who] = ctx;
  }
  // A cria o servidor e convida B e C: os três passam a compartilhar um servidor.
  const a = people.a as BrowserContext;
  const guild = await json<{ id: string; channels: { id: string; type: number }[] }>(
    await a.request.post("/api/guilds", { data: { name: "Servidor DM" } }),
    201,
  );
  const invite = await json<{ code: string }>(
    await a.request.post(`/api/guilds/${guild.id}/invites`, { data: {} }),
    201,
  );
  for (const who of ["b", "c"] as const)
    await json(
      await (people[who] as BrowserContext).request.post(`/api/invites/${invite.code}`),
      200,
    );
  const text = guild.channels.find((c) => c.type === 0);
  guildUrl = `/channels/${guild.id}/${text?.id}`;
  for (const ctx of Object.values(people)) await ctx?.close();
});

async function person(browser: Browser, who: Who): Promise<Person> {
  const ctx = await browser.newContext({ storageState: sessions[who] });
  const page = await ctx.newPage();
  const frames: string[] = [];
  page.on("websocket", (ws) => {
    if (ws.url().includes("/api/gateway"))
      ws.on("framereceived", (f) => frames.push(String(f.payload)));
  });
  return { ctx, page, frames };
}

/** Abre uma URL e espera o READY: a partir daí a pessoa está online e assinou os tópicos. */
async function open(p: Person, url: string) {
  const ready = p.page.waitForEvent("websocket", (ws) => ws.url().includes("/api/gateway"));
  await p.page.goto(url);
  const ws = await ready;
  await ws.waitForEvent("framereceived", (f) => String(f.payload).includes('"READY"'));
}

const dmLog = (p: Person, title: string) =>
  p.page.getByRole("log", { name: `Mensagens de ${title}` });
const conversations = (p: Person) => p.page.getByRole("navigation", { name: "Conversas" });

test("A abre DM com B, trocam mensagens em tempo real e B vê A online e depois offline", async ({
  browser,
}) => {
  const a = await person(browser, "a");
  const b = await person(browser, "b");
  await open(b, "/channels/@me");
  await open(a, guildUrl);

  // A inicia a DM pelo menu do membro B
  const panel = a.page.getByRole("complementary", { name: "Membros" });
  await panel.getByRole("button", { name: `Opções de ${username("b")}` }).click();
  await a.page.getByRole("menuitem", { name: "Enviar mensagem" }).click();
  await expect(a.page).toHaveURL(/\/channels\/@me\/\d+$/);
  await expect(dmLog(a, username("b"))).toBeVisible();

  // B recebe a conversa nova na lista, sem recarregar
  await conversations(b)
    .getByRole("link", { name: new RegExp(`${username("a")}$`) })
    .click();
  await expect(b.page).toHaveURL(/\/channels\/@me\/\d+$/);

  // mensagens nos dois sentidos, em tempo real
  const composerA = a.page.getByLabel(`Mensagem para ${username("b")}`);
  await composerA.fill("oi B, aqui é a A");
  await composerA.press("Enter");
  await expect(dmLog(b, username("a")).getByText("oi B, aqui é a A")).toBeVisible();
  const composerB = b.page.getByLabel(`Mensagem para ${username("a")}`);
  await composerB.fill("oi A, é o B");
  await composerB.press("Enter");
  await expect(dmLog(a, username("b")).getByText("oi A, é o B")).toBeVisible();
  // só o autor exclui: a mensagem de A, vista por B, não oferece "Excluir"
  await expect(
    dmLog(b, username("a")).getByRole("button", { name: "Excluir mensagem" }),
  ).toHaveCount(0);

  // presença: B vê A online no cabeçalho...
  const header = b.page
    .getByRole("banner")
    .filter({ has: b.page.getByRole("heading", { name: username("a") }) });
  await expect(header.getByRole("img", { name: "Online" }).first()).toBeVisible();

  // ...e, quando A fecha a aba, offline depois da tolerância (2 s no backend do E2E)
  await a.page.close();
  await a.ctx.close();
  await expect(header.getByRole("img", { name: "Offline" }).first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(header.getByText("Offline")).toBeVisible();

  await b.ctx.close();
});

test('"digitando…" aparece para B quando A digita e expira em 8 s; some quando A envia', async ({
  browser,
}) => {
  const a = await person(browser, "a");
  const b = await person(browser, "b");
  // a DM já existe (criada no teste anterior); reabrir devolve a mesma
  const dm = await ensureDm(a.ctx, ids.b);
  await open(a, `/channels/@me/${dm.id}`);
  await open(b, `/channels/@me/${dm.id}`);
  const indicatorB = b.page.getByTestId("typing-indicator");
  await expect(indicatorB).toBeEmpty();

  // A digita devagar: o aviso sai na primeira tecla e de novo a cada 3 s (o servidor descarta o
  // que passar de 1 evento a cada 3 s, inclusive um aviso do teste anterior, perto demais)
  await a.page
    .getByLabel(`Mensagem para ${username("b")}`)
    .pressSequentially("estou escrevendo uma mensagem longa", { delay: 150 });
  await expect(indicatorB).toHaveText(`${username("a")} está digitando…`);
  // A para: some depois de ~8 s sem novo evento
  await expect(indicatorB).toBeEmpty({ timeout: 15_000 });

  // digita de novo e envia: o indicador some na hora (sem esperar os 8 s)
  const composer = a.page.getByLabel(`Mensagem para ${username("b")}`);
  await composer.pressSequentially(" mais um pouco", { delay: 150 });
  await expect(indicatorB).toHaveText(`${username("a")} está digitando…`);
  await composer.press("Enter");
  await expect(
    dmLog(b, username("a")).getByText("estou escrevendo uma mensagem longa mais um pouco"),
  ).toBeVisible();
  await expect(indicatorB).toBeEmpty({ timeout: 3_000 });
  // e quem digita não se vê digitando
  await expect(a.page.getByTestId("typing-indicator")).toBeEmpty();

  await a.ctx.close();
  await b.ctx.close();
});

test("A vira ausente depois de 10 min sem interação (relógio acelerado) e volta a online ao interagir", async ({
  browser,
}) => {
  const a = await person(browser, "a");
  const b = await person(browser, "b");
  const dm = await ensureDm(b.ctx, ids.a);
  await open(b, `/channels/@me/${dm.id}`);
  const header = b.page
    .getByRole("banner")
    .filter({ has: b.page.getByRole("heading", { name: username("a") }) });

  // o relógio da página de A é falso: dá para "esperar" 10 minutos sem esperar
  await a.page.clock.install();
  await open(a, `/channels/@me/${dm.id}`);
  await expect(header.getByRole("img", { name: "Online" }).first()).toBeVisible();

  await a.page.clock.fastForward("10:05");
  await expect(header.getByRole("img", { name: "Ausente" }).first()).toBeVisible({
    timeout: 10_000,
  });

  await a.page.mouse.move(200, 200);
  await a.page.mouse.move(260, 240);
  await expect(header.getByRole("img", { name: "Online" }).first()).toBeVisible({
    timeout: 10_000,
  });

  await a.ctx.close();
  await b.ctx.close();
});

test("DM em grupo com três contas: criar, adicionar, remover (o removido deixa de receber)", async ({
  browser,
}) => {
  const a = await person(browser, "a");
  const b = await person(browser, "b");
  const c = await person(browser, "c");
  await open(c, "/channels/@me");
  await open(b, "/channels/@me");
  await open(a, "/channels/@me");

  // A cria o grupo só com B, pelo diálogo
  await a.page.getByRole("button", { name: "Nova conversa em grupo" }).click();
  const dialog = a.page.getByRole("dialog", { name: "Nova conversa em grupo" });
  await dialog.getByLabel("Nome do grupo (opcional)").fill("Grupo E2E");
  await dialog.getByRole("checkbox", { name: new RegExp(`@${username("b")}$`) }).check();
  await dialog.getByRole("button", { name: "Criar conversa" }).click();
  await expect(a.page.getByRole("heading", { name: "Grupo E2E" })).toBeVisible();
  const groupId = /\/channels\/@me\/(\d+)$/.exec(a.page.url())?.[1] ?? "";
  expect(groupId).not.toBe("");

  // B vê o grupo aparecer na lista em tempo real; C ainda não
  await expect(conversations(b).getByRole("link", { name: /Grupo E2E$/ })).toBeVisible();
  await expect(conversations(c).getByRole("link", { name: /Grupo E2E$/ })).toHaveCount(0);

  // A adiciona C pelo diálogo de participantes
  await a.page.getByRole("button", { name: /Participantes \(2\)/ }).click();
  const manage = a.page.getByRole("dialog", { name: "Conversa em grupo" });
  await manage.getByRole("checkbox", { name: new RegExp(`@${username("c")}$`) }).check();
  await manage.getByRole("button", { name: "Adicionar" }).click();
  await expect(
    manage.getByRole("list", { name: "Participantes" }).getByRole("listitem"),
  ).toHaveCount(3);
  await expect(conversations(c).getByRole("link", { name: /Grupo E2E$/ })).toBeVisible();
  await a.page.keyboard.press("Escape");

  // os três conversam
  await conversations(c)
    .getByRole("link", { name: /Grupo E2E$/ })
    .click();
  await conversations(b)
    .getByRole("link", { name: /Grupo E2E$/ })
    .click();
  const say = async (p: Person, text: string) => {
    const box = p.page.getByLabel("Mensagem para Grupo E2E");
    await box.fill(text);
    await box.press("Enter");
  };
  await say(a, "boas-vindas ao grupo");
  await expect(dmLog(b, "Grupo E2E").getByText("boas-vindas ao grupo")).toBeVisible();
  await expect(dmLog(c, "Grupo E2E").getByText("boas-vindas ao grupo")).toBeVisible();
  await say(c, "valeu, cheguei");
  await expect(dmLog(a, "Grupo E2E").getByText("valeu, cheguei")).toBeVisible();

  // A remove C: C é levado à lista com aviso e deixa de receber
  await a.page.getByRole("button", { name: /Participantes \(3\)/ }).click();
  await a.page
    .getByRole("dialog", { name: "Conversa em grupo" })
    .getByRole("button", { name: `Remover ${username("c")}` })
    .click();
  await expect(c.page.getByText(/Você não está mais na conversa Grupo E2E/)).toBeVisible();
  await expect(c.page).toHaveURL(/\/channels\/@me$/);
  await expect(conversations(c).getByRole("link", { name: /Grupo E2E$/ })).toHaveCount(0);
  await a.page.keyboard.press("Escape");

  const seen = c.frames.length;
  await say(a, "só para quem ficou");
  await expect(dmLog(b, "Grupo E2E").getByText("só para quem ficou")).toBeVisible();
  await c.page.waitForTimeout(1_500);
  expect(c.frames.slice(seen).some((f) => f.includes("só para quem ficou"))).toBe(false);
  // e a API também nega o histórico ao removido
  const res = await c.ctx.request.get(`/api/channels/${groupId}/messages`);
  expect(res.status()).toBe(404);

  // B (participante) sai sozinho pelo diálogo
  await b.page.getByRole("button", { name: /Participantes/ }).click();
  await b.page.getByRole("button", { name: "Sair da conversa" }).click();
  await b.page.getByRole("button", { name: "Sair", exact: true }).click();
  await expect(b.page).toHaveURL(/\/channels\/@me$/);
  await expect(a.page.getByRole("button", { name: /Participantes \(1\)/ })).toBeVisible();

  await a.ctx.close();
  await b.ctx.close();
  await c.ctx.close();
});
