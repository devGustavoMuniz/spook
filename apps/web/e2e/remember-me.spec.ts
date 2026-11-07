import { expect, type Page, test } from "@playwright/test";

const PASSWORD = "senha-forte-123";
const run = Date.now().toString(36);

async function register(page: Page, tag: string, opts: { keep: boolean }) {
  const who = {
    email: `e2e-rem-${tag}-${run}@spook.dev`,
    username: `e2e_rem_${tag}_${run}`.slice(0, 32),
  };
  await page.goto("/register");
  const keep = page.getByRole("checkbox", { name: "Manter conectado" });
  await expect(keep).toBeChecked(); // marcado por padrão
  if (!opts.keep) await keep.uncheck();
  await page.getByLabel("E-mail").fill(who.email);
  await page.getByLabel("Nome de usuário").fill(who.username);
  await page.getByLabel("Senha", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Criar conta" }).click();
  await expect(page.getByText("Você ainda não está em nenhum servidor")).toBeVisible();
  return who;
}

test("Manter conectado (padrão): cookie persistente, sobrevive a recarregar e a um contexto novo com storageState", async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await register(page, "on", { keep: true });

  const cookie = (await ctx.cookies()).find((c) => c.name === "spook_session");
  expect(cookie, "cookie de sessão").toBeTruthy();
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe("Lax");
  // persistente: expira em ~90 dias (aceita de 80 a 91)
  const days = ((cookie?.expires ?? 0) - Date.now() / 1000) / 86400;
  expect(days).toBeGreaterThan(80);
  expect(days).toBeLessThan(91);

  await page.reload();
  await expect(page.getByText("Você ainda não está em nenhum servidor")).toBeVisible();

  // "fecha e abre o navegador": um contexto novo só com o que o navegador guardaria em disco
  const state = await ctx.storageState();
  await ctx.close();
  const reopened = await browser.newContext({ storageState: state });
  const again = await reopened.newPage();
  await again.goto("/");
  await expect(again.getByText("Você ainda não está em nenhum servidor")).toBeVisible();
  await expect(again).not.toHaveURL(/\/login/);
  await reopened.close();
});

test("Desmarcado: cookie de sessão (some ao fechar o navegador) e o login envia remember=false", async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const who = await register(page, "off", { keep: false });
  const cookie = (await ctx.cookies()).find((c) => c.name === "spook_session");
  expect(cookie?.expires, "cookie de sessão tem expires = -1").toBe(-1);

  // Navegador fechado: cookies de sessão não vão ao disco, então o contexto novo chega sem eles.
  await ctx.close();
  const fresh = await browser.newContext();
  const p2 = await fresh.newPage();
  await p2.goto("/");
  await expect(p2).toHaveURL(/\/login/);

  // Login desmarcado também gera cookie de sessão.
  await p2.getByLabel("E-mail").fill(who.email);
  await p2.getByLabel("Senha", { exact: true }).fill(PASSWORD);
  const keep = p2.getByRole("checkbox", { name: "Manter conectado" });
  await expect(keep).toBeChecked();
  await keep.uncheck();
  await p2.getByRole("button", { name: "Entrar" }).click();
  await expect(p2.getByText("Você ainda não está em nenhum servidor")).toBeVisible();
  const c2 = (await fresh.cookies()).find((c) => c.name === "spook_session");
  expect(c2?.expires).toBe(-1);

  // E aparece na lista de sessões ativas (Esta sessão).
  await p2.goto("/settings/profile");
  await expect(p2.getByRole("list", { name: "Sessões ativas" })).toBeVisible();
  await expect(p2.getByText("Esta sessão")).toBeVisible();
  await fresh.close();
});
