import { expect, type Page, test } from "@playwright/test";

const PASSWORD = "senha-forte-123";
const NEW_PASSWORD = "outra-senha-456";

// Identificadores únicos por execução: o banco é reaproveitado entre execuções locais.
const run = Date.now().toString(36);
const who = {
  email: `e2e-conta-${run}@spook.dev`,
  username: `e2e_conta_${run}`.slice(0, 32),
};

async function login(page: Page, password: string) {
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(who.email);
  await page.getByLabel("Senha", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Entrar" }).click();
}

test("conta: cadastro, troca de senha, e-mail com confirmação, login com a nova senha e exclusão", async ({
  browser,
}) => {
  // 1. cadastro
  const ctxA = await browser.newContext();
  const a = await ctxA.newPage();
  await a.goto("/register");
  await expect(a.getByRole("heading", { name: "Criar conta" })).toBeVisible();
  await a.getByLabel("E-mail").fill(who.email);
  await a.getByLabel("Nome de usuário").fill(who.username);
  await a.getByLabel("Senha", { exact: true }).fill(PASSWORD);
  await a.getByRole("button", { name: "Criar conta" }).click();
  await expect(a.getByText("Você ainda não está em nenhum servidor")).toBeVisible();

  // 2. segunda sessão (outro dispositivo)
  const ctxB = await browser.newContext();
  const b = await ctxB.newPage();
  await login(b, PASSWORD);
  await expect(b.getByText("Você ainda não está em nenhum servidor")).toBeVisible();

  // 3. trocar a senha na primeira: ela continua logada, a outra cai
  await a.goto("/settings/profile");
  await a.getByLabel("Senha atual").fill(PASSWORD);
  await a.getByLabel("Nova senha", { exact: true }).fill(NEW_PASSWORD);
  await a.getByLabel("Repita a nova senha").fill(NEW_PASSWORD);
  await a.getByRole("button", { name: "Trocar senha" }).click();
  await expect(a.getByText(/Os outros dispositivos foram desconectados/)).toBeVisible();
  await a.reload();
  await expect(a.getByRole("heading", { level: 1, name: "Perfil" })).toBeVisible();
  await b.reload();
  await expect(b).toHaveURL(/\/login/);

  // 4. a sessão que trocou a senha já está confirmada: trocar o e-mail passa direto
  const newEmail = `e2e-conta-novo-${run}@spook.dev`;
  await a.getByLabel("E-mail", { exact: true }).fill(newEmail);
  await a.getByRole("button", { name: "Trocar e-mail" }).click();
  await expect(a.getByText("E-mail alterado.")).toBeVisible();
  who.email = newEmail;

  // 5. outra sessão, sem confirmação recente: o e-mail pede a senha (errada fica no diálogo, certa conclui)
  await login(b, NEW_PASSWORD);
  await expect(b.getByText("Você ainda não está em nenhum servidor")).toBeVisible();
  await b.goto("/settings/profile");
  const lastEmail = `e2e-conta-final-${run}@spook.dev`;
  await b.getByLabel("E-mail", { exact: true }).fill(lastEmail);
  await b.getByRole("button", { name: "Trocar e-mail" }).click();
  const dialog = b.getByRole("dialog", { name: "Confirme sua senha" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Senha").fill("senha-errada-1");
  await dialog.getByRole("button", { name: "Confirmar" }).click();
  await expect(dialog.getByText("Senha incorreta.")).toBeVisible();
  await dialog.getByLabel("Senha").fill(NEW_PASSWORD);
  await dialog.getByRole("button", { name: "Confirmar" }).click();
  await expect(b.getByText("E-mail alterado.")).toBeVisible();
  who.email = lastEmail;

  // 6. a senha antiga não entra mais; a nova (com o e-mail novo) sim
  const ctxC = await browser.newContext();
  const c = await ctxC.newPage();
  await login(c, PASSWORD);
  await expect(c.getByText("E-mail ou senha incorretos.")).toBeVisible();
  await login(c, NEW_PASSWORD);
  await expect(c.getByText("Você ainda não está em nenhum servidor")).toBeVisible();

  // 7. excluir a conta: precisa do username e da senha
  await c.goto("/settings/profile");
  await c.getByRole("button", { name: "Excluir minha conta" }).click();
  const del = c.getByRole("dialog", { name: "Excluir conta" });
  const submit = del.getByRole("button", { name: "Excluir conta" });
  await expect(submit).toBeDisabled();
  await del.getByLabel(new RegExp(`Digite ${who.username} para confirmar`)).fill(who.username);
  await del.getByLabel("Senha").fill(NEW_PASSWORD);
  await submit.click();
  await expect(c).toHaveURL(/\/login/);

  // 8. a conta não existe mais, nem nas outras sessões
  await login(c, NEW_PASSWORD);
  await expect(c.getByText("E-mail ou senha incorretos.")).toBeVisible();
  await a.reload();
  await expect(a).toHaveURL(/\/login/);
  await b.reload();
  await expect(b).toHaveURL(/\/login/);

  await ctxA.close();
  await ctxB.close();
  await ctxC.close();
});
