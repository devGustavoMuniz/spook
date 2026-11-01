import { execSync } from "node:child_process";
import { expect, test } from "@playwright/test";

// Painel administrativo (/admin, adicional). Quem não é admin é barrado (web e API); o admin vê o dashboard
// e a lista de usuários. Promover uma conta exige o banco: o teste roda o comando de E2E_PROMOTE_CMD
// (com {username} no lugar do username); sem ele, o teste do admin é pulado. Exemplos em apps/web/README.md.

const PASSWORD = "senha-forte-123";
const run = Date.now().toString(36);

async function signUp(browser: import("@playwright/test").Browser, prefix: string) {
  const username = `${prefix}_${run}`.slice(0, 32);
  const ctx = await browser.newContext();
  const res = await ctx.request.post("/api/auth/register", {
    data: { email: `${username}@spook.dev`, username, password: PASSWORD },
  });
  expect(res.status()).toBe(201);
  return { ctx, username };
}

test("quem não é admin não entra no painel nem na API", async ({ browser }) => {
  const { ctx } = await signUp(browser, "e2e_nadm");
  expect((await ctx.request.get("/api/admin/overview")).status()).toBe(403);
  const page = await ctx.newPage();
  await page.goto("/admin");
  await expect(page).not.toHaveURL(/\/admin/);
  await page.goto("/channels/@me");
  await expect(page.getByRole("navigation", { name: "Servidores" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Painel de administração" })).toHaveCount(0);
  await ctx.close();
});

test("admin acessa o dashboard e a lista de usuários", async ({ browser }) => {
  const promote = process.env.E2E_PROMOTE_CMD;
  test.skip(!promote, "defina E2E_PROMOTE_CMD para promover a conta (veja apps/web/README.md)");
  const { ctx, username } = await signUp(browser, "e2e_adm");
  execSync((promote as string).replaceAll("{username}", username), { stdio: "pipe" });
  expect((await ctx.request.get("/api/admin/overview")).status()).toBe(200);

  const page = await ctx.newPage();
  await page.goto("/channels/@me");
  await page.getByRole("link", { name: "Painel de administração" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect(page.getByText(/Atualizado em \d\d:\d\d:\d\d/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Ao vivo agora" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Aplicação e armazenamento" })).toBeVisible();

  await page.getByRole("link", { name: "Usuários" }).click();
  await expect(page).toHaveURL(/\/admin\/users$/);
  await page.getByRole("searchbox", { name: "Buscar por usuário ou e-mail" }).fill(username);
  await expect(
    page.getByRole("table", { name: "Usuários" }).getByText(`@${username}`),
  ).toBeVisible();

  await page.getByRole("link", { name: "Servidores" }).click();
  await expect(page.getByRole("heading", { name: "Servidores" })).toBeVisible();
  await page.getByRole("link", { name: "Chamadas" }).click();
  await expect(page.getByRole("heading", { name: "Chamadas" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Voltar ao app/ })).toBeVisible();
  await ctx.close();
});
