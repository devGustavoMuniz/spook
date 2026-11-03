import { expect, test } from "@playwright/test";

const run = Date.now().toString(36);
const who = {
  email: `e2e-i18n-${run}@spook.dev`,
  username: `e2e_i18n_${run}`.slice(0, 32),
  password: "senha-forte-123",
};

test("idioma: trocar para inglês nas configurações, manter após recarregar e voltar para pt-BR", async ({
  page,
}) => {
  // A interface nasce em pt-BR (navegador em pt-BR).
  await page.goto("/register");
  await expect(page.getByRole("heading", { name: "Criar conta" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "pt-BR");
  await page.getByLabel("E-mail").fill(who.email);
  await page.getByLabel("Nome de usuário").fill(who.username);
  await page.getByLabel("Senha", { exact: true }).fill(who.password);
  await page.getByRole("button", { name: "Criar conta" }).click();
  await expect(page.getByText("Você ainda não está em nenhum servidor")).toBeVisible();

  // Configurações -> Aparência e idioma -> English (ao vivo, sem recarregar).
  await page.goto("/settings/appearance");
  await page.getByLabel("Idioma", { exact: true }).selectOption("en");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByLabel("Language", { exact: true })).toBeVisible();

  // Shell e diálogo em inglês.
  await page.goto("/");
  await expect(page.getByText("You're not in any server yet")).toBeVisible();
  await page.getByRole("button", { name: "Add a server" }).click();
  await expect(page.getByRole("dialog").getByText("Create server").first()).toBeVisible();
  await page.keyboard.press("Escape");

  // Persiste após recarregar (localStorage).
  await page.reload();
  await expect(page.getByText("You're not in any server yet")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");

  // O login (sem sessão) também aparece em inglês.
  const other = await page.context().browser()?.newContext({ locale: "en-US" });
  if (!other) throw new Error("sem contexto");
  const p2 = await other.newPage();
  await p2.goto("/login");
  await expect(p2.getByText("Welcome back. Sign in to talk to your crew.")).toBeVisible();
  await other.close();

  // Volta para pt-BR.
  await page.goto("/settings/appearance");
  await page.getByLabel("Language", { exact: true }).selectOption("pt-BR");
  await expect(page.locator("html")).toHaveAttribute("lang", "pt-BR");
  await page.goto("/");
  await expect(page.getByText("Você ainda não está em nenhum servidor")).toBeVisible();
});
