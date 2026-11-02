import {
  type APIRequestContext,
  type BrowserContext,
  expect,
  type Page,
  test,
} from "@playwright/test";

// Voz de ponta a ponta (Fase 5): duas contas em contextos separados entram no mesmo canal de voz com
// mídia falsa do Chromium e o LiveKit de desenvolvimento. NÃO roda no job `e2e` do CI (não há LiveKit lá):
// só com E2E_VOICE=1, num navegador que alcance o LiveKit (veja "Voz" em apps/web/README.md).

const PASSWORD = "senha-forte-123";
const run = Date.now().toString(36);
const name = (who: "a" | "b") => `e2e_voz_${who}_${run}`.slice(0, 32);

type Person = { ctx: BrowserContext; page: Page; username: string };

async function json<T>(
  res: Awaited<ReturnType<APIRequestContext["get"]>>,
  status: number,
): Promise<T> {
  expect(res.status(), await res.text()).toBe(status);
  return (await res.json()) as T;
}

const people: Partial<Record<"a" | "b", Person>> = {};
let url = "";

test.beforeAll(async ({ browser }) => {
  for (const who of ["a", "b"] as const) {
    const ctx = await browser.newContext();
    await json(
      await ctx.request.post("/api/auth/register", {
        data: { email: `e2e-voz-${who}-${run}@spook.dev`, username: name(who), password: PASSWORD },
      }),
      201,
    );
    people[who] = { ctx, page: await ctx.newPage(), username: name(who) };
  }
  const { a, b } = people as Record<"a" | "b", Person>;
  const guild = await json<{ id: string; channels: { id: string; type: number }[] }>(
    await a.ctx.request.post("/api/guilds", { data: { name: "Servidor Voz" } }),
    201,
  );
  const invite = await json<{ code: string }>(
    await a.ctx.request.post(`/api/guilds/${guild.id}/invites`, { data: {} }),
    201,
  );
  await json(await b.ctx.request.post(`/api/invites/${invite.code}`), 200);
  const text = guild.channels.find((c) => c.type === 0);
  url = `/channels/${guild.id}/${text?.id}`;
});

test.afterAll(async () => {
  for (const p of Object.values(people)) await p?.ctx.close();
});

const voiceChannel = (p: Page) =>
  p
    .getByRole("navigation", { name: "Canais" })
    .getByRole("button", { name: /Geral \(canal de voz/ });
const connected = (p: Page) =>
  p.getByRole("region", { name: "Controles de voz" }).getByText("Voz conectada");
// O palco também tem microfone/câmera/tela: os controles da barra lateral ficam na região "Controles de voz".
const dock = (p: Page) => p.getByRole("region", { name: "Controles de voz" });
const inList = (p: Page, who: string) =>
  p
    .getByRole("navigation", { name: "Canais" })
    .getByRole("list", { name: "Conectados" })
    .getByText(who);

test("duas contas na mesma sala: lista, conexão ao LiveKit, mídia, mudo e saída", async () => {
  const { a, b } = people as Record<"a" | "b", Person>;
  await a.page.goto(url);
  await b.page.goto(url);
  await expect(voiceChannel(a.page)).toBeVisible();
  await expect(voiceChannel(b.page)).toBeVisible();

  // A entra: conecta ao LiveKit e aparece para os dois.
  await voiceChannel(a.page).click();
  await expect(connected(a.page)).toBeVisible({ timeout: 20_000 });
  await expect(inList(a.page, a.username)).toBeVisible();
  await expect(inList(b.page, a.username)).toBeVisible();

  // B entra: cada um vê o outro na lista.
  await voiceChannel(b.page).click();
  await expect(connected(b.page)).toBeVisible({ timeout: 20_000 });
  await expect(inList(a.page, b.username)).toBeVisible();
  await expect(inList(b.page, a.username)).toBeVisible();

  // Mídia de verdade: o áudio remoto chegou (elemento <audio> com a faixa do outro lado)...
  await expect(a.page.locator("[data-voice-audio] audio")).toHaveCount(1, { timeout: 20_000 });
  await expect(b.page.locator("[data-voice-audio] audio")).toHaveCount(1, { timeout: 20_000 });

  // ... e o vídeo: a câmera falsa de A chega a B com quadros decodificados.
  await dock(a.page).getByRole("button", { name: "Ligar câmera" }).click();
  await expect(inList(b.page, a.username)).toBeVisible();
  const remoteVideo = b.page.getByRole("region", { name: "Vídeo da chamada" }).locator("video");
  await expect(remoteVideo).toHaveCount(1, { timeout: 20_000 });
  await expect
    .poll(() => remoteVideo.evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 20_000 })
    .toBeGreaterThan(0);

  // Mudo de A reflete no lado de B (e some ao desmutar).
  await dock(a.page).getByRole("button", { name: "Silenciar microfone" }).click();
  await expect(
    b.page
      .getByRole("list", { name: "Conectados" })
      .first()
      .getByRole("img", { name: "Microfone silenciado" }),
  ).toBeVisible();
  await dock(a.page).getByRole("button", { name: "Ativar microfone" }).click();
  await expect(b.page.getByRole("img", { name: "Microfone silenciado" })).toHaveCount(0);

  // Sair remove da lista dos dois lados.
  await a.page.getByRole("button", { name: "Sair da chamada" }).click();
  await expect(a.page.getByRole("region", { name: "Controles de voz" })).toHaveCount(0);
  await expect(inList(b.page, a.username)).toHaveCount(0);
  await expect(inList(b.page, b.username)).toBeVisible();

  // B sai por fim: a lista esvazia.
  await b.page.getByRole("button", { name: "Sair da chamada" }).click();
  await expect(inList(a.page, b.username)).toHaveCount(0);
});

test("prévia da transmissão: B, fora da chamada, vê a miniatura de A, assiste e a tela vem em foco", async () => {
  const { a, b } = people as Record<"a" | "b", Person>;
  await a.page.goto(url);
  await b.page.goto(url);
  await voiceChannel(a.page).click();
  await expect(connected(a.page)).toBeVisible({ timeout: 20_000 });
  await dock(a.page).getByRole("button", { name: "Compartilhar tela" }).click();
  // a prévia vem ligada por padrão (e o áudio desligado)
  await expect(a.page.getByRole("checkbox", { name: "Mostrar prévia para o canal" })).toBeChecked();
  await a.page.getByRole("button", { name: "Compartilhar", exact: true }).click();

  // B ainda não está na chamada: o ícone de tela de A abre o cartão com a miniatura e o botão de assistir
  const trigger = b.page.getByRole("button", { name: `Ver a transmissão de ${a.username}` });
  await expect(trigger).toBeVisible({ timeout: 20_000 });
  await trigger.click();
  const card = b.page.getByRole("dialog", { name: `Transmissão de ${a.username}` });
  await expect(card).toContainText(`Tela de ${a.username}`);
  await expect(card.getByRole("img", { name: `Prévia da tela de ${a.username}` })).toBeVisible({
    timeout: 30_000,
  });

  // Assistir: B entra na chamada e a tela de A fica em foco no palco
  await card.getByRole("button", { name: /Assistir transmissão/ }).click();
  await expect(connected(b.page)).toBeVisible({ timeout: 20_000 });
  await expect(b.page.getByRole("list", { name: "Em destaque" })).toBeVisible({ timeout: 20_000 });
  await expect(
    b.page.getByRole("list", { name: "Em destaque" }).getByTestId("video-tile"),
  ).toHaveAttribute("data-kind", "screen");

  // A para de compartilhar: a prévia some junto (o indicador também)
  await dock(a.page).getByRole("button", { name: "Parar de compartilhar a tela" }).click();
  await expect(b.page.getByRole("img", { name: "Compartilhando a tela" })).toHaveCount(0, {
    timeout: 20_000,
  });
  await a.page.getByRole("button", { name: "Sair da chamada" }).click();
  await b.page.getByRole("button", { name: "Sair da chamada" }).click();
});

test("tela compartilhada de A chega a B em destaque; parar remove o painel", async () => {
  const { a, b } = people as Record<"a" | "b", Person>;
  await a.page.goto(url);
  await b.page.goto(url);
  await voiceChannel(a.page).click();
  await expect(connected(a.page)).toBeVisible({ timeout: 20_000 });
  await voiceChannel(b.page).click();
  await expect(connected(b.page)).toBeVisible({ timeout: 20_000 });

  await dock(a.page).getByRole("button", { name: "Compartilhar tela" }).click();
  // diálogo de compartilhar (áudio desligado por padrão, para não gerar eco)
  await a.page.getByRole("button", { name: "Compartilhar", exact: true }).click();
  const tile = b.page.getByTestId("video-tile").and(b.page.locator('[data-kind="screen"]'));
  await expect(tile).toHaveCount(1, { timeout: 20_000 });
  await expect(b.page.getByRole("img", { name: "Compartilhando a tela" }).first()).toBeVisible();

  await dock(a.page).getByRole("button", { name: "Parar de compartilhar a tela" }).click();
  await expect(tile).toHaveCount(0, { timeout: 20_000 });
  await expect(b.page.getByRole("img", { name: "Compartilhando a tela" })).toHaveCount(0);

  await a.page.getByRole("button", { name: "Sair da chamada" }).click();
  await b.page.getByRole("button", { name: "Sair da chamada" }).click();
  await expect(inList(b.page, a.username)).toHaveCount(0);
});
