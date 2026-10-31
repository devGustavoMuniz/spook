import { expect, test } from "@playwright/test";

// Voz desligada no servidor (sem LIVEKIT_*, como no job `e2e` do CI): o app avisa em pt-br e não quebra.
// Pula sozinho quando o backend tem LiveKit configurado (o fluxo real está em voice.spec.ts).

const PASSWORD = "senha-forte-123";
const run = Date.now().toString(36);

test("sem LiveKit configurado, entrar no canal de voz mostra o aviso de indisponível", async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  const res = await ctx.request.post("/api/auth/register", {
    data: {
      email: `e2e-voff-${run}@spook.dev`,
      username: `e2e_voff_${run}`.slice(0, 32),
      password: PASSWORD,
    },
  });
  expect(res.status()).toBe(201);
  const guild = (await (
    await ctx.request.post("/api/guilds", { data: { name: "Sem Voz" } })
  ).json()) as {
    id: string;
    channels: { id: string; type: number }[];
  };
  const voice = guild.channels.find((c) => c.type === 1);
  const probe = await ctx.request.post(`/api/channels/${voice?.id}/voice/token`);
  test.skip(probe.status() !== 503, "o backend tem LiveKit configurado");

  const page = await ctx.newPage();
  const text = guild.channels.find((c) => c.type === 0);
  await page.goto(`/channels/${guild.id}/${text?.id}`);
  await page
    .getByRole("navigation", { name: "Canais" })
    .getByRole("button", { name: /Geral \(canal de voz/ })
    .click();
  await expect(page.getByText("A voz está indisponível no momento")).toBeVisible();
  await expect(page.getByRole("region", { name: "Controles de voz" })).toHaveCount(0);
  await ctx.close();
});
