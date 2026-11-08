import { expect, test } from "@playwright/test";

// Configurações em modal sobre o app: abrir pela engrenagem, trocar de seção, rolar o conteúdo até o fim,
// Esc fecha e volta ao canal (sem recarregar), e deep link /settings/<seção> abre o modal sobre o início.

const PASSWORD = "senha-forte-123";
const run = Date.now().toString(36);

test("configurações: modal pela engrenagem, seções, rolagem, Esc e deep link", async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  const reg = await ctx.request.post("/api/auth/register", {
    data: {
      email: `e2e-setmodal-${run}@spook.dev`,
      username: `e2e_setmodal_${run}`.slice(0, 32),
      password: PASSWORD,
    },
  });
  expect(reg.status()).toBe(201);
  const guild = (await (
    await ctx.request.post("/api/guilds", { data: { name: "Modal" } })
  ).json()) as { id: string; channels: { id: string; type: number }[] };
  const text = guild.channels.find((c) => c.type === 0);
  const channelPath = `/channels/${guild.id}/${text?.id}`;
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1280, height: 700 });
  await page.goto(channelPath);
  await expect(page.getByRole("navigation", { name: "Servidores" })).toBeVisible();

  // abre pela engrenagem: o app continua atrás e a URL é a máscara
  await page.getByRole("button", { name: "Configurações do usuário" }).click();
  const modal = page.getByRole("dialog", { name: "Configurações" });
  await expect(modal).toBeVisible();
  await expect(modal.getByRole("heading", { level: 1, name: "Perfil" })).toBeVisible();
  await expect(page).toHaveURL(/\/settings\/profile$/);
  const box = await modal.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(900);
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(700);

  // troca de seção pelo menu agrupado
  const nav = modal.getByRole("navigation", { name: "Seções das configurações" });
  await expect(nav.getByRole("heading", { name: "Conta" })).toBeVisible();
  await expect(nav.getByRole("heading", { name: "App" })).toBeVisible();
  await nav.getByRole("link", { name: "Voz e vídeo" }).click();
  await expect(modal.getByRole("heading", { level: 1, name: "Voz e vídeo" })).toBeVisible();
  await expect(page).toHaveURL(/\/settings\/voice$/);

  // o conteúdo rola até o fim (independente do menu) e o último controle é alcançável
  await nav.getByRole("link", { name: "Perfil" }).click();
  const main = modal.getByRole("main");
  const m = await main.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
  expect(m.sh).toBeGreaterThan(m.ch);
  await main.hover();
  await page.mouse.wheel(0, 100000);
  await expect
    .poll(() => main.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
    .toBeLessThan(2);
  await expect(modal.getByRole("button", { name: "Excluir minha conta" }).last()).toBeInViewport();

  // Esc fecha e volta ao canal, sem recarregar
  await page.evaluate(() => {
    (window as unknown as { __marker: number }).__marker = 1;
  });
  await page.keyboard.press("Escape");
  await expect(modal).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`${channelPath}$`));
  expect(await page.evaluate(() => (window as unknown as { __marker?: number }).__marker)).toBe(1);

  // deep link: abre o app com o modal na seção
  await page.goto("/settings/notifications");
  await expect(
    page.getByRole("dialog", { name: "Configurações" }).getByRole("heading", {
      level: 1,
      name: "Notificações",
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Fechar configurações" }).click();
  await expect(page.getByRole("dialog", { name: "Configurações" })).toBeHidden();
  await ctx.close();
});
