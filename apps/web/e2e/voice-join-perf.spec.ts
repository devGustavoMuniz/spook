import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

// Medição da ENTRADA no canal de voz (fases em `src/features/voice/join-perf.ts`). Roda no projeto `voice`
// (E2E_VOICE=1, LiveKit local; ver "Voz" no README). Uma conta entra e sai do canal N vezes (padrão 10) em cada
// cenário de microfone e imprime a mediana por fase (ms desde o clique). `JOIN_PERF_OUT=<arquivo>` grava o JSON.

const PASSWORD = "senha-forte-123";
const RUNS = Number(process.env.JOIN_PERF_RUNS ?? 10);
const run = Date.now().toString(36);

type W = { __voiceJoinPerf?: Record<string, number> };

const push = (m: Record<string, number[]>, k: string, v: number) => {
  const list = m[k] ?? [];
  list.push(v);
  m[k] = list;
};

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s[Math.floor((s.length - 1) / 2)] ?? 0) : 0;
};

const SCENARIOS: Record<string, unknown> = {
  // Padrão do app: eco/ruído padrão do navegador, sem porta.
  padrao: {},
  // Pior caso: IA (RNNoise em WASM + worklet) e porta automática.
  forte: { noiseSuppression: "strong", inputSensitivity: { mode: "auto", thresholdDb: -50 } },
};

test("entrada no canal de voz: mediana das fases", async ({ browser }) => {
  test.setTimeout(10 * 60_000);
  const ctx = await browser.newContext();
  const reg = await ctx.request.post("/api/auth/register", {
    data: {
      email: `e2e-lat-${run}@spook.dev`,
      username: `e2e_lat_${run}`.slice(0, 32),
      password: PASSWORD,
    },
  });
  expect(reg.status()).toBe(201);
  const guild = (await (
    await ctx.request.post("/api/guilds", { data: { name: "Latência" } })
  ).json()) as {
    id: string;
    channels: { id: string; type: number }[];
  };
  const text = guild.channels.find((c) => c.type === 0);
  if (process.env.JOIN_PERF_SIM === "1") {
    // Rede/hardware simulados (a rede local não mostra o que o usuário sente): +120 ms no token (ida e volta até o
    // servidor por túnel) e +250 ms para abrir o microfone (dispositivo real, driver, permissão).
    await ctx.route("**/voice/token", async (r) => {
      await new Promise((res) => setTimeout(res, 120));
      await r.continue();
    });
    await ctx.addInitScript(() => {
      const md = navigator.mediaDevices;
      const real = md.getUserMedia.bind(md);
      md.getUserMedia = async (c) => {
        await new Promise((res) => setTimeout(res, 250));
        return real(c);
      };
    });
  }
  const page = await ctx.newPage();
  const tokenMs: number[] = [];
  if (process.env.JOIN_PERF_DEBUG) {
    page.on("console", (m) => {
      if (m.type() === "warning" || m.type() === "error")
        console.log(`[console ${m.type()}] ${m.text().slice(0, 300)}`);
    });
    page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
  }
  page.on("response", async (r) => {
    if (!r.url().includes("/voice/token")) return;
    const st = r.headers()["server-timing"];
    const m = st?.match(/dur=([\d.]+)/);
    if (m) tokenMs.push(Number(m[1]));
  });
  const result: Record<string, Record<string, number>> = {};
  for (const [name, ap] of Object.entries(SCENARIOS)) {
    await page.addInitScript(
      ([key, value]) => localStorage.setItem(key as string, JSON.stringify(value)),
      ["spook:voice-audio-processing", ap] as const,
    );
    await page.goto(`/channels/${guild.id}/${text?.id}`);
    const channel = page
      .getByRole("navigation", { name: "Canais" })
      .getByRole("button", { name: /Geral \(canal de voz/ });
    const samples: Record<string, number[]> = {};
    const external: number[] = [];
    for (let i = 0; i < RUNS + 1; i++) {
      await expect(channel).toBeVisible();
      await page.evaluate(() => {
        (window as unknown as W).__voiceJoinPerf = undefined;
      });
      console.log(`entrada ${name} #${i}`);
      const t0 = Date.now();
      await channel.click();
      await expect(
        page.getByRole("region", { name: "Controles de voz" }).getByText("Voz conectada"),
      ).toBeVisible({ timeout: 30_000 });
      const wall = Date.now() - t0;
      await page.waitForFunction(
        () => {
          const r = (window as unknown as W).__voiceJoinPerf;
          return r?.confirmed !== undefined && r?.ready !== undefined;
        },
        null,
        { timeout: 15_000 },
      );
      const perf = await page.evaluate(() => {
        const r = (window as unknown as W).__voiceJoinPerf ?? {};
        const c = r.click ?? 0;
        return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v - c]));
      });
      if (i > 0) {
        // a 1ª entrada aquece cache de módulos/WASM/DNS e não entra na mediana (a de um usuário real é a 1ª, ver relatório)
        for (const [k, v] of Object.entries(perf)) push(samples, k, v);
        external.push(wall);
      } else {
        for (const [k, v] of Object.entries(perf)) push(samples, `primeira:${k}`, v);
      }
      await page.getByRole("button", { name: "Sair da chamada" }).click();
      await expect(page.getByRole("region", { name: "Controles de voz" })).toHaveCount(0);
      await page.waitForTimeout(2300); // limite voice.token: 30 por minuto
    }
    result[name] = {
      ...Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, Math.round(median(v))])),
      externo: Math.round(median(external)),
      tokenServidor: Math.round(median(tokenMs)),
    };
  }
  console.log(`JOIN_PERF ${JSON.stringify(result)}`);
  if (process.env.JOIN_PERF_OUT)
    writeFileSync(process.env.JOIN_PERF_OUT, JSON.stringify(result, null, 2));
  await ctx.close();
});
