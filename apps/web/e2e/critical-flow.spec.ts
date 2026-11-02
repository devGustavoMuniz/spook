import { type Browser, expect, type Page, test } from "@playwright/test";

const PASSWORD = "senha-forte-123";

// Identificadores únicos por execução: o banco é reaproveitado entre execuções locais.
const run = Date.now().toString(36);
const user = (tag: string) => ({
  email: `e2e-${tag}-${run}@spook.dev`,
  username: `e2e_${tag}_${run}`.slice(0, 32),
});

async function register(page: Page, who: { email: string; username: string }) {
  // espera a tela de cadastro montar (vindo do link do login, os campos do login somem junto)
  await expect(page.getByRole("heading", { name: "Criar conta" })).toBeVisible();
  await page.getByLabel("E-mail").fill(who.email);
  await page.getByLabel("Nome de usuário").fill(who.username);
  await page.getByLabel("Senha", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Criar conta" }).click();
}

async function newPage(browser: Browser) {
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

test("cadastro, servidor, mensagem, convite e segunda conta", async ({ browser }) => {
  const ana = user("ana");
  const bia = user("bia");
  const { context: ctxA, page: a } = await newPage(browser);

  // 1. cadastro e estado vazio
  await a.goto("/register");
  await register(a, ana);
  await expect(a.getByText("Você ainda não está em nenhum servidor")).toBeVisible();

  // 2. criar servidor => canal de texto "geral" e canal de voz "Geral"
  await a.getByRole("button", { name: "Criar servidor" }).click();
  await a.getByLabel("Nome do servidor").fill("Servidor E2E");
  await a.getByRole("button", { name: "Criar servidor" }).last().click();
  await expect(a.getByRole("heading", { name: "geral" })).toBeVisible();
  const channels = a.getByRole("navigation", { name: "Canais" });
  await expect(channels.getByRole("link", { name: "geral" })).toBeVisible();
  await expect(channels.getByText("Geral", { exact: true })).toBeVisible();
  await expect(a.getByRole("link", { name: "Servidor E2E" })).toBeVisible();

  // 3. enviar mensagem e ver que continua depois de recarregar
  const composer = a.getByLabel("Mensagem em #geral");
  await composer.fill("olá do E2E");
  await composer.press("Enter");
  const log = a.getByRole("log", { name: "Mensagens de geral" });
  await expect(log.getByText("olá do E2E")).toBeVisible();
  await a.reload();
  await expect(
    a.getByRole("log", { name: "Mensagens de geral" }).getByText("olá do E2E"),
  ).toBeVisible();

  // 4. criar convite
  await a.getByRole("button", { name: /Menu do servidor/ }).click();
  await a.getByRole("menuitem", { name: /Convidar pessoas/ }).click();
  await a.getByRole("button", { name: "Criar convite" }).click();
  const code = (await a.locator("li p.font-mono").first().textContent())?.trim();
  expect(code).toMatch(/^[A-Za-z0-9]{8}$/);

  // 5. segunda conta, em outro contexto de navegador, entra pelo convite
  const { context: ctxB, page: b } = await newPage(browser);
  await b.goto(`/invite/${code}`);
  await expect(b.getByRole("heading", { name: "Entrar" })).toBeVisible(); // pede login
  await b.getByRole("link", { name: "Cadastre-se" }).click();
  await register(b, bia);
  await expect(b.getByText("Servidor E2E")).toBeVisible(); // prévia do convite, depois do cadastro
  await b.getByRole("button", { name: "Entrar no servidor" }).click();
  await expect(b.getByRole("heading", { name: "geral" })).toBeVisible();
  await expect(
    b.getByRole("log", { name: "Mensagens de geral" }).getByText("olá do E2E"),
  ).toBeVisible();
  await expect(
    b.getByRole("complementary", { name: "Membros" }).getByText(ana.username),
  ).toBeVisible();

  await ctxA.close();
  await ctxB.close();
});
