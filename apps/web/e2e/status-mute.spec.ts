import { type BrowserContext, expect, type Page, test } from "@playwright/test";

// Adicional: status (Não perturbar, Invisível, status personalizado) e silenciar/nível de notificação, com
// duas contas em contextos separados contra o backend real. A (dona) e B (membro).

const PASSWORD = "senha-forte-123";
const run = Date.now().toString(36);
const names = { a: `e2e_sm_a_${run}`.slice(0, 32), b: `e2e_sm_b_${run}`.slice(0, 32) };

type Who = "a" | "b";
const sessions: Partial<Record<Who, Awaited<ReturnType<BrowserContext["storageState"]>>>> = {};
let channelUrl = "";

test.beforeAll(async ({ browser }) => {
  const ctxs: Record<Who, BrowserContext> = {
    a: await browser.newContext(),
    b: await browser.newContext(),
  };
  for (const who of ["a", "b"] as const) {
    const res = await ctxs[who].request.post("/api/auth/register", {
      data: { email: `e2e-sm-${who}-${run}@spook.dev`, username: names[who], password: PASSWORD },
    });
    expect(res.status(), await res.text()).toBe(201);
    sessions[who] = await ctxs[who].storageState();
  }
  const g = await ctxs.a.request.post("/api/guilds", { data: { name: "Servidor Status" } });
  expect(g.status()).toBe(201);
  const guild = (await g.json()) as { id: string; channels: { id: string; type: number }[] };
  const inv = await ctxs.a.request.post(`/api/guilds/${guild.id}/invites`, { data: {} });
  const { code } = (await inv.json()) as { code: string };
  expect((await ctxs.b.request.post(`/api/invites/${code}`)).status()).toBe(200);
  channelUrl = `/channels/${guild.id}/${guild.channels.find((c) => c.type === 0)?.id}`;
  await ctxs.a.close();
  await ctxs.b.close();
});

async function open(browser: import("@playwright/test").Browser, who: Who): Promise<Page> {
  const ctx = await browser.newContext({ storageState: sessions[who] });
  const page = await ctx.newPage();
  await page.goto(channelUrl);
  await expect(page.getByRole("log", { name: /Mensagens de/ })).toBeVisible();
  return page;
}

test("status personalizado, Não perturbar e Invisível chegam ao outro lado em tempo real", async ({
  browser,
}) => {
  const a = await open(browser, "a");
  const b = await open(browser, "b");
  const members = b.getByRole("complementary", { name: "Membros" });
  const rowA = members.getByRole("listitem").filter({ hasText: names.a });
  await expect(rowA.locator('[data-status="online"]')).toBeVisible();

  // A define um status personalizado de 1 hora
  await a.getByRole("button", { name: /Mudar status/ }).click();
  await a.getByRole("menuitem", { name: /Definir status personalizado/ }).click();
  const dialog = a.getByRole("dialog", { name: "Status personalizado" });
  await dialog.getByLabel("O que você está fazendo?").fill("em reunião");
  await dialog.getByRole("button", { name: "Usar 💻" }).click();
  await dialog.getByRole("radio", { name: "1 hora" }).check();
  await dialog.getByRole("button", { name: "Salvar" }).click();
  await expect(rowA).toContainText("💻 em reunião");

  // Não perturbar: ponto vermelho para B (e para a própria A)
  await a.getByRole("button", { name: /Mudar status/ }).click();
  await a.getByRole("menuitem", { name: /Não perturbar/ }).click();
  await expect(rowA.locator('[data-status="dnd"]')).toBeVisible();
  await expect(a.getByRole("button", { name: /Status: Não perturbar/ })).toBeVisible();

  // Invisível: B vê A offline (sem status personalizado); A se vê invisível
  await a.getByRole("button", { name: /Mudar status/ }).click();
  await a.getByRole("menuitem", { name: /Invisível/ }).click();
  await expect(rowA.locator('[data-status="offline"]')).toBeVisible();
  await expect(rowA).not.toContainText("em reunião");
  await expect(a.getByRole("button", { name: /Status: Invisível/ })).toBeVisible();

  // A preferência persiste ao recarregar
  await a.reload();
  await expect(a.getByRole("button", { name: /Status: Invisível/ })).toBeVisible();
  await a.getByRole("button", { name: /Mudar status/ }).click();
  await a.getByRole("menuitem", { name: /Online/ }).click();
  await expect(rowA.locator('[data-status="online"]')).toBeVisible();
});

test("silenciar o servidor por 1 hora: indicador, sem toast, não lidas continuam; reativar volta a avisar", async ({
  browser,
}) => {
  const a = await open(browser, "a");
  const b = await open(browser, "b");
  // B fica em outra tela (as DMs); A manda mensagens com menção a B
  await b.goto("/channels/@me");
  await b.getByRole("button", { name: /Mudar status/ }).waitFor();
  const boxA = a.getByRole("textbox", { name: /Mensagem em #/ });

  // B silencia o servidor por 1 hora pelo menu do cabeçalho do canal (na tela do servidor)
  await b.goto(channelUrl);
  await expect(b.getByRole("log", { name: /Mensagens de/ })).toBeVisible();
  await b.getByRole("button", { name: /Menu do servidor/ }).click();
  await b.getByRole("menuitem", { name: /Silenciar o servidor/ }).click();
  await b.getByRole("menuitem", { name: "Por 1 hora" }).click();
  await expect(
    b
      .getByRole("navigation", { name: "Servidores" })
      .getByRole("img", { name: "Servidor silenciado" }),
  ).toBeVisible();

  // vai para as DMs e recebe uma menção: contagem sobe, mas nenhum toast aparece
  await b.goto("/channels/@me");
  await boxA.fill(`@${names.b} olha isso`);
  await boxA.press("Enter");
  await expect(
    b
      .getByRole("navigation", { name: "Servidores" })
      .getByRole("img", { name: /menção em Servidor Status/ }),
  ).toBeVisible();
  await expect(b.getByText("olha isso")).toHaveCount(0);

  // reativar: a próxima menção avisa
  await b.goto(channelUrl);
  await b.getByRole("button", { name: /Menu do servidor/ }).click();
  await b.getByRole("menuitem", { name: /Reativar o servidor/ }).click();
  await expect(
    b
      .getByRole("navigation", { name: "Servidores" })
      .getByRole("img", { name: "Servidor silenciado" }),
  ).toHaveCount(0);
  await b.goto("/channels/@me");
  await boxA.fill(`@${names.b} agora sim`);
  await boxA.press("Enter");
  await expect(b.getByText("agora sim")).toBeVisible();
});
