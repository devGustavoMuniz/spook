import { execSync } from "node:child_process";
import { expect, test } from "@playwright/test";

// Chamados de feedback (adicional): o usuário abre um chamado em Configurações > Ajuda e feedback, o admin o vê em
// /admin/tickets, escreve uma nota interna e responde, e o usuário vê a resposta (sem a nota). Promover o admin
// exige o banco: usa E2E_PROMOTE_CMD como o admin.spec.ts ou, sem acesso ao banco (container do Playwright), uma
// conta de admin que já existe (E2E_ADMIN_USERNAME, com a senha dos testes), criada e promovida antes da rodada;
// sem nenhum dos dois, é pulado.

const PASSWORD = "senha-forte-123";
const run = Date.now().toString(36);
// PNG de 1x1 pixel (assinatura válida: o servidor confere os primeiros bytes).
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function signUp(browser: import("@playwright/test").Browser, prefix: string) {
  const username = `${prefix}_${run}`.slice(0, 32);
  const ctx = await browser.newContext();
  const res = await ctx.request.post("/api/auth/register", {
    data: { email: `${username}@spook.dev`, username, password: PASSWORD },
  });
  expect(res.status()).toBe(201);
  return { ctx, username };
}

/** Entra numa conta que já existe (a de admin preparada fora do teste). */
async function signIn(browser: import("@playwright/test").Browser, username: string) {
  const ctx = await browser.newContext();
  const res = await ctx.request.post("/api/auth/login", {
    data: { email: `${username}@spook.dev`, password: PASSWORD },
  });
  expect(res.status()).toBe(200);
  return { ctx, username };
}

test("usuário abre um chamado, o admin responde e o usuário vê a resposta", async ({ browser }) => {
  test.setTimeout(120_000);
  const promote = process.env.E2E_PROMOTE_CMD;
  const fixedAdmin = process.env.E2E_ADMIN_USERNAME;
  test.skip(
    !promote && !fixedAdmin,
    "defina E2E_PROMOTE_CMD ou E2E_ADMIN_USERNAME (veja apps/web/README.md)",
  );
  const user = await signUp(browser, "e2e_fb_u");
  const admin = fixedAdmin ? await signIn(browser, fixedAdmin) : await signUp(browser, "e2e_fb_a");
  if (promote && !fixedAdmin) {
    execSync(promote.replaceAll("{username}", admin.username), { stdio: "pipe" });
  }
  const title = `Tela preta ao compartilhar ${run}`;

  // 1) Usuário: Configurações > Ajuda e feedback > novo chamado.
  const upage = await user.ctx.newPage();
  await upage.goto("/settings/feedback");
  await expect(upage.getByRole("heading", { level: 1, name: "Ajuda e feedback" })).toBeVisible();
  await upage.getByRole("radio", { name: /Bug/ }).check({ force: true });
  await upage.getByLabel("Título").fill(title);
  await upage.getByLabel("Descrição").fill("Ao compartilhar a tela inteira o vídeo fica preto.");
  await expect(upage.getByLabel("O que será enviado")).toBeVisible();
  // Captura de tela anexada ao abrir o chamado.
  await upage
    .locator('input[type="file"]')
    .setInputFiles({ name: "captura.png", mimeType: "image/png", buffer: PNG_1X1 });
  await expect(upage.getByText("Pronto")).toBeVisible();
  await upage.getByRole("button", { name: "Enviar chamado" }).click();
  await expect(upage.getByRole("heading", { level: 2, name: title })).toBeVisible();
  await expect(upage.getByText("Ao compartilhar a tela inteira o vídeo fica preto.")).toBeVisible();
  await expect(upage.getByRole("button", { name: /captura\.png/ })).toBeVisible();

  // Volta à lista: assim a resposta chega como "não lida" (com a conversa aberta ela já nasce lida).
  await upage.getByRole("button", { name: "Voltar aos chamados" }).click();

  // Quem não é admin não chega à fila nem pela API.
  expect((await user.ctx.request.get("/api/admin/tickets")).status()).toBe(403);

  // 2) Admin: a fila mostra o chamado; nota interna e resposta pública.
  const apage = await admin.ctx.newPage();
  await apage.goto("/admin/tickets");
  await expect(apage.getByRole("heading", { name: "Chamados", level: 1 })).toBeVisible();
  await expect(apage.getByRole("list", { name: "Chamados" })).toBeVisible();
  const search = apage.getByRole("searchbox", { name: "Buscar por título ou usuário" });
  await search.fill(title);
  await expect(search).toHaveValue(title);
  await apage.getByRole("link", { name: new RegExp(title) }).click();
  await expect(apage.getByRole("heading", { level: 2, name: title })).toBeVisible();
  await expect(apage.getByText(`@${user.username}`).first()).toBeVisible();
  await expect(apage.getByRole("link", { name: `${user.username}@spook.dev` })).toBeVisible();
  await expect(apage.getByRole("button", { name: /captura\.png/ })).toBeVisible();

  await apage.getByRole("checkbox", { name: /Nota interna/ }).check();
  await apage
    .getByRole("textbox", { name: "Nota interna" })
    .fill("SEGREDO-INTERNO: parece driver.");
  await apage.getByRole("button", { name: "Salvar nota" }).click();
  await expect(apage.getByText("SEGREDO-INTERNO: parece driver.")).toBeVisible();

  await apage.getByRole("checkbox", { name: /Nota interna/ }).uncheck();
  await apage
    .getByRole("textbox", { name: "Responder ao usuário" })
    .fill("Obrigado! Já estamos olhando.");
  await apage.getByRole("button", { name: "Enviar resposta" }).click();
  await expect(apage.getByRole("textbox", { name: "Responder ao usuário" })).toHaveValue("");
  await expect(apage.getByText("Resposta da equipe")).toBeVisible();

  // 3) Usuário: o aviso chega ao vivo (gateway) e a conversa mostra a resposta, nunca a nota interna.
  await expect(upage.getByText("A equipe respondeu ao seu chamado.")).toBeVisible();
  await expect(upage.getByText("Nova resposta")).toBeVisible();
  await expect(upage.getByText("Respondido")).toBeVisible();
  await upage.getByRole("button", { name: new RegExp(title) }).click();
  await expect(upage.getByText("Obrigado! Já estamos olhando.")).toBeVisible();
  await expect(upage.getByText("Equipe do Spook")).toBeVisible();
  await expect(upage.getByText("SEGREDO-INTERNO")).toHaveCount(0);

  // 4) Admin resolve; o usuário reabre pela conversa.
  await apage.getByLabel("Alterar o estado").selectOption("resolved");
  await expect(apage.getByText('Estado alterado para "Resolvido".')).toBeVisible();
  await expect(upage.getByRole("button", { name: "Reabrir chamado" })).toBeVisible();
  await upage.getByRole("button", { name: "Reabrir chamado" }).click();
  await expect(upage.getByText("Chamado reaberto.")).toBeVisible();

  // 5) Responsivo: 390 px sem rolagem horizontal, no modal e na fila do admin.
  await upage.setViewportSize({ width: 390, height: 844 });
  await apage.setViewportSize({ width: 390, height: 844 });
  await apage.goto("/admin/tickets");
  await expect
    .poll(() => apage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
    .toBe(true);
  await user.ctx.close();
  await admin.ctx.close();
});
