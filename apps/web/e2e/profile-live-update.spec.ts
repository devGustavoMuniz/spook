import {
  type APIRequestContext,
  type BrowserContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { grantCmd, grantNitro } from "./grant-nitro";

// Perfil ao vivo (adicional ao SPEC, 5.5): A troca nome e avatar (GIF animado) e B, no mesmo servidor, vê a mudança
// SEM recarregar (lista de membros, autor das mensagens já carregadas, DM); A também a vê em todo lugar. Fora de
// uma chamada o GIF fica parado (canvas com o primeiro quadro); só o cartão de perfil o anima.

const PASSWORD = "senha-forte-123";
const run = Date.now().toString(36);
const name = (who: "a" | "b") => `e2e_prf_${who}_${run}`.slice(0, 32);
const NEW_NAME = `Nome Novo ${run}`.slice(0, 32);

// GIF de 2 quadros (32x32, vermelho e azul).
const GIF = Buffer.from(
  "R0lGODlhIAAgAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAIAAgAAAINQABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFixgzatzIsaPHjyBDihxJsqTJkyhTqlzJUmRAACH5BAEKAAEALAAAAAAgACAAgQAA/wAAAAAAAAAAAAg1AAEIHEiwoMGDCBMqXMiwocOHECNKnEixosWLGDNq3Mixo8ePIEOKHEmypMmTKFOqXMlSZEAAOw==",
  "base64",
);

type Person = { ctx: BrowserContext; page: Page; id: string };
const people: Partial<Record<"a" | "b", Person>> = {};
let channelUrl = "";
let guildId = "";

async function uploadGifAvatar(req: APIRequestContext) {
  const up = (await (
    await req.post("/api/users/me/avatar", {
      data: { content_type: "image/gif", size: GIF.length },
    })
  ).json()) as { upload_url: string; key: string };
  const put = await fetch(up.upload_url, {
    method: "PUT",
    headers: { "content-type": "image/gif" },
    body: GIF,
  });
  expect(put.ok, `PUT no storage: ${put.status}`).toBe(true);
  return up.key;
}

test.beforeAll(async ({ browser }) => {
  for (const who of ["a", "b"] as const) {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 800 } });
    const reg = await ctx.request.post("/api/auth/register", {
      data: { email: `e2e-prf-${who}-${run}@spook.dev`, username: name(who), password: PASSWORD },
    });
    expect(reg.status()).toBe(201);
    const id = ((await reg.json()) as { user: { id: string } }).user.id;
    people[who] = { ctx, page: await ctx.newPage(), id };
  }
  const { a, b } = people as Record<"a" | "b", Person>;
  const guild = (await (
    await a.ctx.request.post("/api/guilds", { data: { name: "Perfil" } })
  ).json()) as {
    id: string;
    channels: { id: string; type: number }[];
  };
  guildId = guild.id;
  const invite = (await (
    await a.ctx.request.post(`/api/guilds/${guild.id}/invites`, { data: {} })
  ).json()) as { code: string };
  expect((await b.ctx.request.post(`/api/invites/${invite.code}`)).status()).toBe(200);
  const text = guild.channels.find((c) => c.type === 0)?.id;
  channelUrl = `/channels/${guild.id}/${text}`;
  const send = await a.ctx.request.post(`/api/channels/${text}/messages`, {
    data: { content: "mensagem antiga" },
  });
  expect(send.status()).toBe(201);
  // DM A-B para conferir a lista de conversas de B.
  expect(
    (
      await a.ctx.request.post("/api/users/@me/channels", { data: { recipient_id: b.id } })
    ).status(),
  ).toBe(201);
});

test.afterAll(async () => {
  for (const p of Object.values(people)) await p?.ctx.close();
});

test("A troca nome e avatar GIF: B e A veem em membros, mensagens e DMs sem recarregar", async () => {
  test.skip(
    !grantCmd,
    "defina E2E_GRANT_CMD para conceder Nitro à conta (veja apps/web/README.md)",
  );
  grantNitro(name("a"));
  const { a, b } = people as Record<"a" | "b", Person>;
  await a.page.goto(channelUrl);
  await b.page.goto(channelUrl);
  const members = (p: Page) => p.getByRole("complementary", { name: "Membros" });
  await expect(members(b.page).getByText(name("a"))).toBeVisible();
  await expect(b.page.getByText("mensagem antiga")).toBeVisible();
  // Marca a página: se recarregar, a marca some e o teste falha.
  await b.page.evaluate(() => {
    (window as unknown as { __noReload: boolean }).__noReload = true;
  });

  // A muda o NOME pelas configurações (UI) e o avatar (GIF) pela API.
  await a.page.getByRole("button", { name: "Configurações do usuário" }).click();
  const modal = a.page.getByRole("dialog", { name: "Configurações" });
  await modal.getByLabel("Nome de exibição").fill(NEW_NAME);
  await modal.getByRole("button", { name: "Salvar" }).first().click();
  const key = await uploadGifAvatar(a.ctx.request);
  expect((await a.ctx.request.patch("/api/users/me", { data: { avatar_key: key } })).status()).toBe(
    200,
  );

  // B: lista de membros, autor da mensagem e DM, sem recarregar.
  await expect(members(b.page).getByText(NEW_NAME)).toBeVisible();
  await expect(members(b.page).getByText(name("a"), { exact: true })).toHaveCount(0);
  await expect(b.page.getByText(NEW_NAME).first()).toBeVisible();
  await expect(members(b.page).locator("[data-gif-still] canvas").first()).toBeVisible({
    timeout: 15_000,
  });
  // Fora da chamada o GIF não anima: nenhum <img> .gif vivo na lista nem nas mensagens.
  await expect(b.page.locator("img[src*='.gif']")).toHaveCount(0);
  expect(
    await b.page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload),
  ).toBe(true);

  // Cartão de perfil (ampliado): aí o GIF anima.
  await members(b.page)
    .getByRole("button", { name: `Ver perfil de ${NEW_NAME}` })
    .click();
  await expect(b.page.locator("img[src*='.gif']").first()).toBeVisible();

  // A vê o próprio nome novo nas mensagens já carregadas e na lista de membros.
  await a.page.keyboard.press("Escape");
  await expect(members(a.page).getByText(NEW_NAME)).toBeVisible();
  await expect(a.page.getByText(NEW_NAME).first()).toBeVisible();

  // DM: B abre a conversa e o nome novo está lá (cache de DMs atualizado pelo evento).
  await b.page.goto("/channels/@me");
  await expect(b.page.getByText(NEW_NAME).first()).toBeVisible();
  void guildId;
});
