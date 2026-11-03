import { expect, type Page, test } from "@playwright/test";

// E-mail e recuperação de senha (adicional). Precisa de um backend em desenvolvimento com
// MAILER_DRIVER=log e MAIL_FLOWS_ON_LOG=true: o e-mail sai no log e na caixa de saída de desenvolvimento
// (GET /api/dev/mail/last, que NÃO existe em produção). Sem isso, o teste pula sozinho.
const PASSWORD = "senha-forte-123";
const NEW_PASSWORD = "outra-senha-789";
const run = Date.now().toString(36);
const who = { email: `e2e-mail-${run}@spook.dev`, username: `e2e_mail_${run}`.slice(0, 32) };

async function lastMail(page: Page, to: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const res = await page.request.get(`/api/dev/mail/last?to=${encodeURIComponent(to)}`);
    if (res.ok()) return ((await res.json()) as { text: string }).text;
    await page.waitForTimeout(250);
  }
  throw new Error(`nenhum e-mail para ${to}`);
}

const linkOf = (text: string, path: string): string => {
  const m = text.match(new RegExp(`https?://[^\\s]*${path}\\?token=[A-Za-z0-9_-]+`));
  if (!m) throw new Error(`link ${path} ausente no e-mail:\n${text}`);
  const u = new URL(m[0]);
  return u.pathname + u.search; // o E2E navega pelo baseURL do teste, não pelo PUBLIC_URL do e-mail
};

test("e-mail: verificação do cadastro e recuperação de senha por link", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const providers = (await (await page.request.get("/api/auth/providers")).json()) as {
    email_enabled: boolean;
  };
  test.skip(!providers.email_enabled, "backend sem e-mail ligado (MAIL_FLOWS_ON_LOG)");

  // cadastro => e-mail de verificação e faixa no app
  await page.goto("/register");
  await page.getByLabel("E-mail").fill(who.email);
  await page.getByLabel("Nome de usuário").fill(who.username);
  await page.getByLabel("Senha", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Criar conta" }).click();
  await expect(page.getByText("Você ainda não está em nenhum servidor")).toBeVisible();
  await expect(page.getByText("Verifique seu e-mail.")).toBeVisible();

  // o link do e-mail abre em OUTRO navegador (sem sessão) e confirma
  const verifyLink = linkOf(await lastMail(page, who.email), "/verify-email");
  const other = await (await browser.newContext()).newPage();
  await other.goto(verifyLink);
  await expect(other.getByRole("heading", { name: "E-mail confirmado" })).toBeVisible();
  await expect(other).not.toHaveURL(/token=/); // o token sai da URL
  // link de uso único
  await other.goto(verifyLink);
  await expect(other.getByRole("heading", { name: "Link expirado" })).toBeVisible();

  // a faixa some depois de verificar
  await page.reload();
  await expect(page.getByText("Você ainda não está em nenhum servidor")).toBeVisible();
  await expect(page.getByText("Verifique seu e-mail.")).toHaveCount(0);

  // sair e pedir a recuperação de senha
  await page.request.post("/api/auth/logout");
  await page.goto("/login");
  await page.getByRole("link", { name: "Esqueci minha senha" }).click();
  await expect(page.getByRole("heading", { name: "Esqueci minha senha" })).toBeVisible();
  await page.getByLabel("E-mail").fill(`ninguem-${run}@spook.dev`);
  await page.getByRole("button", { name: "Enviar link" }).click();
  await expect(page.getByRole("heading", { name: "Confira seu e-mail" })).toBeVisible(); // resposta igual p/ conta inexistente
  await page.goto("/forgot-password");
  await page.getByLabel("E-mail").fill(who.email);
  await page.getByRole("button", { name: "Enviar link" }).click();
  await expect(page.getByRole("heading", { name: "Confira seu e-mail" })).toBeVisible();

  const resetLink = linkOf(
    await (async () => {
      // o último e-mail ao endereço agora é o de redefinição
      for (let i = 0; i < 40; i++) {
        const t = await lastMail(page, who.email);
        if (t.includes("/reset-password?token=")) return t;
        await page.waitForTimeout(250);
      }
      throw new Error("e-mail de redefinição não chegou");
    })(),
    "/reset-password",
  );
  await page.goto(resetLink);
  await expect(page).not.toHaveURL(/token=/);
  await page.getByLabel("Nova senha", { exact: true }).fill(NEW_PASSWORD);
  await page.getByLabel("Repita a nova senha").fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Redefinir senha" }).click();
  await expect(page.getByRole("heading", { name: "Senha redefinida" })).toBeVisible();

  // a senha antiga não vale; a nova entra
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(who.email);
  await page.getByLabel("Senha", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByText("E-mail ou senha incorretos.")).toBeVisible();
  await page.getByLabel("Senha", { exact: true }).fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByText("Você ainda não está em nenhum servidor")).toBeVisible();
});
