import { type BrowserContext, expect, type Page, test } from "@playwright/test";

// Adicional: responder, editar a última com ↑ e fixar mensagens, com duas contas em contextos separados
// contra o backend real. A (dona do servidor, com MANAGE_MESSAGES) e B (membro comum).

const PASSWORD = "senha-forte-123";
const run = Date.now().toString(36);
const names = { a: `e2e_rp_a_${run}`.slice(0, 32), b: `e2e_rp_b_${run}`.slice(0, 32) };

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
      data: { email: `e2e-rp-${who}-${run}@spook.dev`, username: names[who], password: PASSWORD },
    });
    expect(res.status(), await res.text()).toBe(201);
    sessions[who] = await ctxs[who].storageState();
  }
  const g = await ctxs.a.request.post("/api/guilds", { data: { name: "Servidor Respostas" } });
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

test("responder (citação para os dois lados), fixar (painel) e editar a última com ↑", async ({
  browser,
}) => {
  const a = await open(browser, "a");
  const b = await open(browser, "b");
  const boxA = a.getByRole("textbox", { name: /Mensagem em #/ });
  const boxB = b.getByRole("textbox", { name: /Mensagem em #/ });

  // A escreve; B vê chegar por tempo real
  await boxA.fill("quem topa estudar Go hoje?");
  await boxA.press("Enter");
  const original = b.getByRole("article").filter({ hasText: "quem topa estudar Go hoje?" });
  await expect(original).toBeVisible();

  // B responde pela ação "Responder": barra com a prévia, depois a citação aparece nos dois lados
  await original.hover();
  await original.getByRole("button", { name: "Responder" }).click();
  await expect(b.getByRole("group", { name: `Respondendo a ${names.a}` })).toBeVisible();
  await expect(boxB).toBeFocused();
  await boxB.fill("eu topo!");
  await boxB.press("Enter");
  for (const page of [a, b]) {
    const reply = page.getByRole("article").filter({ hasText: "eu topo!" });
    await expect(reply).toBeVisible();
    await expect(reply.getByRole("button", { name: /Ir para a mensagem original/ })).toContainText(
      "quem topa estudar Go hoje?",
    );
  }
  await expect(b.getByRole("group", { name: /Respondendo a/ })).toHaveCount(0);

  // A fixa a mensagem de B: o painel dos dois lados mostra (B não vê o botão de fixar)
  const reply = a.getByRole("article").filter({ hasText: "eu topo!" });
  await reply.hover();
  await reply.getByRole("button", { name: "Fixar mensagem" }).click();
  await expect(reply.getByRole("img", { name: "Mensagem fixada" })).toBeVisible();
  const replyB = b.getByRole("article").filter({ hasText: "eu topo!" });
  await expect(replyB.getByRole("img", { name: "Mensagem fixada" })).toBeVisible();
  await replyB.hover();
  await expect(replyB.getByRole("button", { name: /Fixar mensagem/ })).toHaveCount(0);
  await b.getByRole("button", { name: "Mensagens fixadas" }).click();
  const panel = b.getByRole("dialog", { name: "Mensagens fixadas" });
  await expect(panel.getByRole("listitem")).toHaveCount(1);
  await expect(panel).toContainText("eu topo!");
  await expect(panel.getByRole("button", { name: /Desafixar/ })).toHaveCount(0);
  await panel.getByRole("button", { name: /Ir para a mensagem/ }).click();
  await expect(panel).toHaveCount(0);

  // A edita a própria última mensagem com ↑ no campo vazio; Esc cancela, ↑ de novo e Enter salva
  await boxA.click();
  await boxA.press("ArrowUp");
  const edit = a.getByRole("textbox", { name: "Editar mensagem" });
  await expect(edit).toHaveValue("quem topa estudar Go hoje?");
  await edit.press("Escape");
  await expect(edit).toHaveCount(0);
  await boxA.press("ArrowUp");
  await edit.fill("quem topa estudar Go hoje à noite?");
  await edit.press("Enter");
  await expect(
    b
      .getByRole("article", { name: `Mensagem de ${names.a}` })
      .filter({ hasText: "quem topa estudar Go hoje à noite?" }),
  ).toBeVisible();
  // a citação de B acompanha o texto editado
  await expect(
    b
      .getByRole("article")
      .filter({ hasText: "eu topo!" })
      .getByRole("button", { name: /Ir para a mensagem original/ }),
  ).toContainText("hoje à noite?");
});
