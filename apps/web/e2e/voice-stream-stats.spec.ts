import { writeFileSync } from "node:fs";
import {
  type APIRequestContext,
  type BrowserContext,
  expect,
  type Page,
  test,
} from "@playwright/test";

// Qualidade e saúde da transmissão de tela (adicional ao SPEC, 5.5): A compartilha uma "tela" falsa de 1920x1080 a
// 30 fps (getDisplayMedia substituído por um canvas animado: o do Chromium falso não tem resolução controlável) e
// B assiste em tile PEQUENO e depois em FOCO. Mede o que B de fato recebe (inbound-rtp do RTCPeerConnection:
// resolução, fps e bitrate), o que A de fato envia (outbound-rtp) e o tempo até o primeiro quadro. NÃO roda no CI
// (precisa de LiveKit): só com E2E_VOICE=1. `STATS_OUT=/caminho.json` grava a tabela medida; `STATS_ASSERT=0`
// desliga as asserções de qualidade (para medir um build antigo).

const PASSWORD = "senha-forte-123";
const run = Date.now().toString(36);
const name = (who: "a" | "b" | "c") => `e2e_stats_${who}_${run}`.slice(0, 32);
const ASSERT = process.env.STATS_ASSERT !== "0";

type Person = { ctx: BrowserContext; page: Page; username: string };

async function json<T>(
  res: Awaited<ReturnType<APIRequestContext["get"]>>,
  status: number,
): Promise<T> {
  expect(res.status(), await res.text()).toBe(status);
  return (await res.json()) as T;
}

/** Guarda todos os RTCPeerConnection da página (para ler getStats) e, em A, troca o getDisplayMedia por um canvas. */
function initScript(fakeScreen: boolean) {
  return `
    (() => {
      const Orig = window.RTCPeerConnection;
      window.__pcs = [];
      window.RTCPeerConnection = function (...args) {
        const pc = new Orig(...args);
        window.__pcs.push(pc);
        return pc;
      };
      window.RTCPeerConnection.prototype = Orig.prototype;
      window.__snap = async () => {
        const out = [];
        for (const pc of window.__pcs) {
          let rep;
          try { rep = await pc.getStats(); } catch { continue; }
          const codecs = {};
          rep.forEach((r) => { if (r.type === 'codec') codecs[r.id] = r.mimeType; });
          rep.forEach((r) => {
            if (r.kind !== 'video' || (r.type !== 'inbound-rtp' && r.type !== 'outbound-rtp')) return;
            out.push({
              type: r.type, rid: r.rid || '', w: r.frameWidth || 0, h: r.frameHeight || 0,
              frames: r.framesDecoded ?? r.framesEncoded ?? 0, bytes: r.bytesReceived ?? r.bytesSent ?? 0,
              t: r.timestamp, codec: codecs[r.codecId] || '', limit: r.qualityLimitationReason || '',
              keyFrames: r.keyFramesDecoded ?? r.keyFramesEncoded ?? 0,
            });
          });
        }
        return out;
      };
      if (${fakeScreen}) {
        const W = 1920, H = 1080;
        const canvas = document.createElement('canvas');
        canvas.width = W; canvas.height = H;
        const g = canvas.getContext('2d');
        let f = 0;
        const draw = () => {
          f++;
          g.fillStyle = '#1e1e2e'; g.fillRect(0, 0, W, H);
          g.font = '20px monospace'; g.fillStyle = '#cdd6f4';
          // texto de código rolando (3 px por quadro): borda fina que sofre com a compressão
          for (let i = 0; i < 60; i++) {
            const y = ((i * 24 - f * 3) % (H + 24) + (H + 24)) % (H + 24);
            g.fillText('const resultado = calcular(entrada[' + i + '], opcoes) // linha ' + i + ' ' + 'x'.repeat(i % 40), 40, y);
          }
          // movimento e "ruído" (janela de vídeo)
          for (let k = 0; k < 40; k++) {
            g.fillStyle = 'hsl(' + ((f * 7 + k * 31) % 360) + ',70%,55%)';
            g.fillRect(1100 + ((k * 53 + f * 11) % 700), 200 + ((k * 97 + f * 5) % 600), 90, 60);
          }
          requestAnimationFrame(draw);
        };
        draw();
        navigator.mediaDevices.getDisplayMedia = async () => canvas.captureStream(30);
      }
    })();
  `;
}

type Snap = {
  type: string;
  rid: string;
  w: number;
  h: number;
  frames: number;
  bytes: number;
  t: number;
  codec: string;
  limit: string;
  keyFrames: number;
};

async function snap(p: Page): Promise<Snap[]> {
  return p.evaluate(() => (window as unknown as { __snap: () => Promise<Snap[]> }).__snap());
}

type Measure = {
  width: number;
  height: number;
  fps: number;
  kbps: number;
  codec: string;
  limit: string;
  layers: number;
  videoElement: string;
};

/** Mede `type` (inbound = B, outbound = A) durante `ms`: fps e kbps da camada mais alta. */
async function measure(p: Page, type: "inbound-rtp" | "outbound-rtp", ms = 6000): Promise<Measure> {
  const pick = (s: Snap[]) => s.filter((x) => x.type === type);
  const a = pick(await snap(p));
  await p.waitForTimeout(ms);
  const b = pick(await snap(p));
  const top = b.reduce<Snap | undefined>(
    (best, x) => (!best || x.w > best.w ? x : best),
    undefined,
  );
  const before = a.find((x) => x.rid === top?.rid && x.type === top?.type);
  if (!top || !before) throw new Error(`sem estatísticas ${type}`);
  const dt = (top.t - before.t) / 1000;
  const el = await p
    .locator("video")
    .first()
    .evaluate(
      (v: HTMLVideoElement) =>
        `${v.videoWidth}x${v.videoHeight} @ css ${v.clientWidth}x${v.clientHeight}`,
    )
    .catch(() => "");
  return {
    width: top.w,
    height: top.h,
    fps: Math.round(((top.frames - before.frames) / dt) * 10) / 10,
    kbps: Math.round(((top.bytes - before.bytes) * 8) / 1000 / dt),
    codec: top.codec,
    limit: top.limit,
    layers: b.length,
    videoElement: el,
  };
}

/** A fonte de vídeo de B tem imagem de verdade (não é preto)? Desenha o `<video>` num canvas pequeno. */
async function videoIsLit(p: Page): Promise<boolean> {
  return p.evaluate(() => {
    const v = document.querySelector<HTMLVideoElement>('[data-kind="screen"] video, video');
    if (!v || v.videoWidth === 0) return false;
    const c = document.createElement("canvas");
    c.width = 64;
    c.height = 36;
    const g = c.getContext("2d");
    if (!g) return false;
    g.drawImage(v, 0, 0, 64, 36);
    const d = g.getImageData(0, 0, 64, 36).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += (d[i] ?? 0) + (d[i + 1] ?? 0) + (d[i + 2] ?? 0);
    return sum / (64 * 36 * 3) > 12;
  });
}

const people: Partial<Record<"a" | "b" | "c", Person>> = {};
let url = "";
const results: Record<string, unknown> = {};

test.beforeAll(async ({ browser }) => {
  for (const who of ["a", "b", "c"] as const) {
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    await ctx.addInitScript(initScript(who === "a"));
    await json(
      await ctx.request.post("/api/auth/register", {
        data: {
          email: `e2e-stats-${who}-${run}@spook.dev`,
          username: name(who),
          password: PASSWORD,
        },
      }),
      201,
    );
    people[who] = { ctx, page: await ctx.newPage(), username: name(who) };
  }
  const { a, b, c } = people as Record<"a" | "b" | "c", Person>;
  const guild = await json<{ id: string; channels: { id: string; type: number }[] }>(
    await a.ctx.request.post("/api/guilds", { data: { name: "Servidor Estatísticas" } }),
    201,
  );
  // O convite padrão tem um uso só: pede um com usos para os dois convidados.
  const invite = await json<{ code: string }>(
    await a.ctx.request.post(`/api/guilds/${guild.id}/invites`, { data: { max_uses: 5 } }),
    201,
  );
  // A primeira resposta do convite às vezes é 404 logo após o cadastro, embora a entrada tenha sido gravada (achado
  // do E2E, ver RELATORIO-ADICIONAIS.md): repete até 200 (quem já é membro não consome uso).
  for (const guest of [b, c]) {
    let status = 0;
    for (let i = 0; i < 4 && status !== 200; i++) {
      status = (await guest.ctx.request.post(`/api/invites/${invite.code}`)).status();
      if (status !== 200) await new Promise((r) => setTimeout(r, 300));
    }
    expect(status).toBe(200);
  }
  const text = guild.channels.find((ch) => ch.type === 0);
  url = `/channels/${guild.id}/${text?.id}`;
});

test.afterAll(async () => {
  if (process.env.STATS_OUT) writeFileSync(process.env.STATS_OUT, JSON.stringify(results, null, 2));
  console.log(`STATS_RESULT ${JSON.stringify(results)}`);
  for (const p of Object.values(people)) await p?.ctx.close();
});

const voiceChannel = (p: Page) =>
  p
    .getByRole("navigation", { name: "Canais" })
    .getByRole("button", { name: /Geral \(canal de voz/ });
const connected = (p: Page) =>
  p.getByRole("region", { name: "Controles de voz" }).getByText("Voz conectada");
const dock = (p: Page) => p.getByRole("region", { name: "Controles de voz" });
const screenTile = (p: Page) => p.getByTestId("video-tile").and(p.locator('[data-kind="screen"]'));

async function join(p: Person) {
  await p.page.goto(url);
  await voiceChannel(p.page).click();
  await expect(connected(p.page)).toBeVisible({ timeout: 25_000 });
}

async function startShare(p: Person) {
  await dock(p.page).getByRole("button", { name: "Compartilhar tela" }).click();
  // padrão do diálogo: 1080p / 30 fps
  await p.page.getByRole("button", { name: "Compartilhar", exact: true }).click();
  await expect(
    dock(p.page).getByRole("button", { name: "Parar de compartilhar a tela" }),
  ).toBeVisible({
    timeout: 20_000,
  });
}

const SMALL_CSS =
  'li[data-kind="screen"] video { width: 240px !important; height: 135px !important; }';

test("qualidade: B assiste a tela 1080p30 de A em tile pequeno e em foco", async () => {
  test.setTimeout(180_000);
  const { a, b } = people as Record<"a" | "b", Person>;
  await join(a);
  await join(b);
  await startShare(a);

  // B ainda não assiste: o tile de A mostra o botão. Assistir.
  await b.page.getByRole("button", { name: /^Assistir tela de / }).click({ timeout: 25_000 });
  await expect(screenTile(b.page)).toHaveCount(1, { timeout: 25_000 });

  // ---- tile PEQUENO (240x135 CSS) ----
  await b.page.addStyleTag({ content: SMALL_CSS });
  await b.page.waitForTimeout(5000); // o adaptiveStream reage em ~100 ms; dá tempo à camada trocar
  const small = await measure(b.page, "inbound-rtp");
  results.smallTile = small;

  // ---- FOCO / tela cheia do palco (remove o limite do tile e destaca) ----
  await b.page.evaluate(() => {
    for (const s of document.querySelectorAll("style"))
      if (s.textContent?.includes("240px")) s.remove();
  });
  const highlight = b.page.getByRole("button", { name: /^Destacar tela de / }).first();
  if (await highlight.count()) await highlight.click();
  await b.page.waitForTimeout(5000);
  const focus = await measure(b.page, "inbound-rtp");
  results.focusTile = focus;

  const sent = await measure(a.page, "outbound-rtp");
  results.sender = sent;
  console.log(
    `MEDIDO pequeno=${JSON.stringify(small)} foco=${JSON.stringify(focus)} envio=${JSON.stringify(sent)}`,
  );

  if (ASSERT) {
    // O que A escolheu (1080p/30): o espectador recebe 1080 de altura em QUALQUER tamanho de tile.
    for (const [label, m] of [
      ["tile pequeno", small],
      ["foco", focus],
    ] as const) {
      expect(m.height, `${label}: altura recebida`).toBeGreaterThanOrEqual(1070);
      // A fonte falsa (canvas) e o codificador por software dependem da CPU do contêiner (8 a 20 fps conforme a
      // carga da máquina); o que a correção garante é a RESOLUÇÃO, então o fps só precisa mostrar que flui.
      expect(m.fps, `${label}: fps`).toBeGreaterThanOrEqual(5);
    }
    expect(sent.layers, "o publicador não usa simulcast na tela").toBe(1);
  }
  await dock(a.page).getByRole("button", { name: "Parar de compartilhar a tela" }).click();
  await a.page.getByRole("button", { name: "Sair da chamada" }).click();
  await b.page.getByRole("button", { name: "Sair da chamada" }).click();
});

test("tela preta: assistir, parar e assistir de novo, e entrar depois do início, sempre com imagem", async () => {
  test.setTimeout(240_000);
  const { a, b, c } = people as Record<"a" | "b" | "c", Person>;
  await join(a);
  await join(b);
  await startShare(a);

  const times: number[] = [];
  for (let i = 0; i < 3; i++) {
    await b.page.getByRole("button", { name: /^Assistir tela de / }).click({ timeout: 25_000 });
    const tile = screenTile(b.page);
    await expect(tile).toHaveCount(1, { timeout: 25_000 });
    // O tile só mostra o vídeo quando há o primeiro quadro (placeholder até lá).
    await expect(tile).toHaveAttribute("data-frame-state", "ready", { timeout: 15_000 });
    const ms = Number(await tile.getAttribute("data-first-frame-ms"));
    times.push(ms);
    await expect.poll(() => videoIsLit(b.page), { timeout: 10_000 }).toBe(true);
    await b.page.getByRole("button", { name: /^Parar de assistir a tela de / }).click();
    await expect(screenTile(b.page)).toHaveCount(0, { timeout: 15_000 });
  }
  results.firstFrameMsWatchCycles = times;

  // C entra DEPOIS de A já transmitir.
  await join(c);
  const t0 = Date.now();
  await c.page.getByRole("button", { name: /^Assistir tela de / }).click({ timeout: 25_000 });
  const tileC = screenTile(c.page);
  await expect(tileC).toHaveAttribute("data-frame-state", "ready", { timeout: 15_000 });
  results.lateJoinerFirstFrameMs = Date.now() - t0;
  await expect.poll(() => videoIsLit(c.page), { timeout: 10_000 }).toBe(true);

  // Painel de estatísticas pelo menu do tile (diagnóstico): mostra a resolução recebida.
  await screenTile(c.page)
    .getByRole("button", { name: /^Opções de / })
    .click();
  await c.page.getByRole("menuitemcheckbox", { name: "Estatísticas da transmissão" }).click();
  const panel = c.page.getByTestId("stream-stats");
  await expect(panel).toBeVisible();
  await expect
    .poll(async () => Number(await panel.getAttribute("data-height")), { timeout: 10_000 })
    .toBeGreaterThan(0);
  results.panel = {
    width: await panel.getAttribute("data-width"),
    height: await panel.getAttribute("data-height"),
    fps: await panel.getAttribute("data-fps"),
    kbps: await panel.getAttribute("data-kbps"),
    codec: await panel.getAttribute("data-codec"),
    layer: await panel.getAttribute("data-layer"),
  };
  console.log(`PAINEL ${JSON.stringify(results.panel)} CICLOS ${JSON.stringify(times)}`);

  // Quem transmite também vê o painel (lado de envio, com o motivo de limitação do codificador).
  await screenTile(a.page)
    .getByRole("button", { name: /^Opções de / })
    .click();
  await a.page.getByRole("menuitemcheckbox", { name: "Estatísticas da transmissão" }).click();
  const sendPanel = a.page.getByTestId("stream-stats");
  await expect(sendPanel).toHaveAttribute("data-role", "send", { timeout: 10_000 });
  await expect
    .poll(async () => await sendPanel.getAttribute("data-limitation"), { timeout: 10_000 })
    .not.toBe("");

  await dock(a.page).getByRole("button", { name: "Parar de compartilhar a tela" }).click();
  await expect(screenTile(c.page)).toHaveCount(0, { timeout: 20_000 });
  for (const p of [a, b, c]) await p.page.getByRole("button", { name: "Sair da chamada" }).click();
});
