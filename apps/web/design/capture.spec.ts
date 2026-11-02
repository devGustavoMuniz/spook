import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import {
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  expect,
  type Page,
  test,
} from "@playwright/test";

// Captura de telas do Spook, em tema claro/escuro e 1440x900 / 390x844.
//
//   DESIGN_OUT=antes  -> docs/design/antes   (estado atual, antes da repaginação)
//   DESIGN_OUT=depois -> docs/design/depois  (mesmas telas, mesmos nomes: dá para comparar lado a lado)
//
// Pré-requisitos (veja apps/web/README.md): infra de pé (`pnpm infra:up`), build do web servido pelo
// backend em E2E_BASE_URL (padrão http://localhost:8090), CORS do Garage liberando essa origem e
// LiveKit local para o palco de voz. Rodar:
//
//   DESIGN_OUT=antes pnpm --filter @spook/web exec playwright test -c design/playwright.config.ts design/capture.spec.ts
//
// Opcional: DESIGN_PROMOTE_CMD (com {username}) promove o admin para /admin; o padrão usa o Postgres do
// Compose. DESIGN_ONLY=chave[,chave] filtra as telas (substring do nome; a numeração dos arquivos não muda). É idempotente: cada execução cria
// contas e servidores novos (sufixo único). Telas que não puderem ser capturadas vão para `_falhas.txt`.

const OUT = process.env.DESIGN_OUT ?? "antes";
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "../../../docs/design", OUT);
const ONLY = process.env.DESIGN_ONLY;
const PASSWORD = "senha-forte-123";
const run = Date.now().toString(36).slice(-4);
const promoteCmd =
  process.env.DESIGN_PROMOTE_CMD ??
  `docker exec spook-postgres-1 psql -U spook -c "UPDATE users SET is_admin = true WHERE username = '{username}'"`;

const VIEWPORTS = [
  { key: "1440", width: 1440, height: 900 },
  { key: "390", width: 390, height: 844 },
] as const;
const THEMES = ["claro", "escuro"] as const;

type Who = "ana" | "bruno" | "carla";
type Person = { id: string; username: string; ctx: BrowserContext };
const people = {} as Record<Who, Person>;
const failures: string[] = [];
const numbers = new Map<string, number>();
// Capturas acrescentadas depois da numeração original: número fixo, para não deslocar as demais.
const FIXED_NUMBERS: Record<string, number> = {
  "barra-servidores-hover": 87,
  "categoria-recolhida": 88,
  "voz-tile-convite": 91,
  "voz-foco": 92,
  "voz-barra-visivel": 93,
  "voz-menu-do-tile": 94,
  "voz-barra-oculta": 95,
  "chat-lightbox": 81,
  "chat-cartao-perfil": 82,
  "chat-acoes-hover": 83,
  "chat-acoes-toque": 84,
  "chat-composer-anexos": 85,
  "chat-membros-grupos": 86,
  "dm-grupo-conversa": 96,
  "dialogo-participantes": 97,
  "dialogo-convite-copiado": 98,
};
let guildId = "";
const ids = {
  general: "",
  empty: "",
  dev: "",
  voice: "",
  voice2: "",
  dm: "",
  roleMod: "",
};
let inviteCode = "";
let dmWithBruno = "";
let dmGroup = "";

async function json<T>(res: Awaited<ReturnType<APIRequestContext["get"]>>, ok = [200, 201, 204]) {
  const text = await res.text();
  expect(ok, `${res.url()} -> ${res.status()} ${text}`).toContain(res.status());
  return (text ? JSON.parse(text) : {}) as T;
}

// ---- imagem PNG gerada na hora (gradiente em tons da marca) ----
function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}
function makePng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) {
      row[1 + x * 3] = 40 + (x * 90) / width;
      row[2 + x * 3] = 20 + (y * 60) / height;
      row[3 + x * 3] = 110 + (x * 120) / width;
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function register(browser: Browser, who: string, display: string): Promise<Person> {
  const ctx = await browser.newContext();
  const username = `${who}_${run}`;
  const res = await json<{ user: { id: string } }>(
    await ctx.request.post("/api/auth/register", {
      data: { email: `${who}-${run}@spook.dev`, username, password: PASSWORD },
    }),
  );
  await json(await ctx.request.patch("/api/users/me", { data: { display_name: display } }));
  return { id: res.user.id, username, ctx };
}

async function send(
  who: Who,
  channelId: string,
  content: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  // O backend limita o ritmo de envio (429): espera e tenta de novo.
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await people[who].ctx.request.post(`/api/channels/${channelId}/messages`, {
      data: { content, ...extra },
    });
    if (res.status() === 429) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    const m = await json<{ id: string }>(res);
    await new Promise((r) => setTimeout(r, 350));
    return m.id;
  }
  throw new Error("mensagem bloqueada por limite de taxa");
}

async function attach(
  who: Who,
  channelId: string,
  filename: string,
  contentType: string,
  body: Buffer,
): Promise<string> {
  const req = people[who].ctx.request;
  const up = await json<{ id: string; upload_url: string; headers: Record<string, string> }>(
    await req.post(`/api/channels/${channelId}/uploads`, {
      data: { filename, content_type: contentType, size: body.length },
    }),
  );
  const put = await fetch(up.upload_url, {
    method: "PUT",
    headers: up.headers,
    body: new Uint8Array(body),
  });
  expect(put.ok, `PUT ${filename}: ${put.status}`).toBeTruthy();
  return up.id;
}

function sql(q: string) {
  try {
    execSync(`docker exec spook-postgres-1 psql -U spook -c "${q}"`, { stdio: "pipe" });
  } catch (e) {
    failures.push(`sql falhou (${q.slice(0, 40)}…): ${String(e).slice(0, 120)}`);
  }
}

/** Empurra mensagens para trás no tempo (o horário vem do Snowflake do ID): mensagens em dias diferentes. */
function backdate(messageIds: string[], days: number) {
  const shift = BigInt(days) * 86_400_000n * 4194304n; // ms << 22
  sql(`UPDATE messages SET id = id - ${shift} WHERE id IN (${messageIds.join(",")})`);
}

async function setup(browser: Browser) {
  people.ana = await register(browser, "ana", "Ana Lima");
  people.bruno = await register(browser, "bruno", "Bruno Reis");
  people.carla = await register(browser, "carla", "Carla Nunes");
  if (promoteCmd) {
    try {
      execSync(promoteCmd.replace("{username}", people.ana.username), { stdio: "pipe" });
    } catch (e) {
      failures.push(`admin: não foi possível promover (${String(e).slice(0, 100)})`);
    }
  }

  const a = people.ana.ctx.request;
  const guild = await json<{ id: string; channels: { id: string; type: number; name: string }[] }>(
    await a.post("/api/guilds", { data: { name: "Laboratório Spook" } }),
  );
  guildId = guild.id;
  ids.general = guild.channels.find((c) => c.type === 0)?.id ?? "";
  ids.voice = guild.channels.find((c) => c.type === 1)?.id ?? "";
  const mk = async (name: string, type: number, parent?: string) =>
    (
      await json<{ id: string }>(
        await a.post(`/api/guilds/${guildId}/channels`, {
          data: { name, type, parent_id: parent },
        }),
      )
    ).id;
  ids.dev = await mk("desenvolvimento", 0);
  ids.empty = await mk("vazio", 0);
  await mk("avisos", 0);
  ids.voice2 = await mk("Sala de estudos", 1);

  const invite = await json<{ code: string }>(
    await a.post(`/api/guilds/${guildId}/invites`, { data: {} }),
  );
  inviteCode = invite.code;
  await json(await people.bruno.ctx.request.post(`/api/invites/${inviteCode}`));
  await json(await people.carla.ctx.request.post(`/api/invites/${inviteCode}`));

  // cargos
  const mod = await json<{ id: string }>(
    await a.post(`/api/guilds/${guildId}/roles`, {
      data: {
        name: "Moderação",
        color: 0x7c5cc4,
        permissions: (1 << 4) | (1 << 8) | (1 << 6) | (1 << 7),
        position: 1,
      },
    }),
  );
  ids.roleMod = mod.id;
  const des = await json<{ id: string }>(
    await a.post(`/api/guilds/${guildId}/roles`, {
      data: { name: "Design", color: 0xe5a13a, permissions: 0, position: 1 },
    }),
  );
  await a.put(`/api/guilds/${guildId}/members/${people.bruno.id}/roles/${mod.id}`);
  await a.put(`/api/guilds/${guildId}/members/${people.carla.id}/roles/${des.id}`);

  // mensagens antigas primeiro (viram "anteontem" e "ontem" depois)
  const old1 = await send(
    "bruno",
    ids.general,
    "Bom dia, pessoal! Quem vai na reunião de planejamento?",
  );
  const old2 = await send("carla", ids.general, "Eu vou. Levo as anotações da última semana.");
  const old3 = await send("ana", ids.general, "Fechado, então. Vejo vocês às 14h.");
  backdate([old1, old2], 2);
  backdate([old3], 1);
  const yest = await send(
    "bruno",
    ids.general,
    "Ontem terminei a tela de login nova, ficou bonita.",
  );
  backdate([yest], 1);

  await send("ana", ids.general, "Bem-vindos ao Laboratório Spook!");
  await send("bruno", ids.general, "Oi! Que bom estar aqui.");
  await send(
    "bruno",
    ids.general,
    "Segunda mensagem seguida do mesmo autor, para ver o agrupamento.",
  );
  await send(
    "carla",
    ids.general,
    "Mensagem longa para testar quebra de linha e leitura em colunas estreitas: o Spook é um clone do Discord feito para estudo, com chat em tempo real, canais de voz e vídeo, compartilhamento de tela, cargos com permissões e muito mais. A ideia é medir o desempenho de cada parte e entender onde cada decisão pesa. Uma frase comprida assim precisa continuar legível no celular e no desktop, sem estourar o contêiner nem encostar nas bordas.",
  );
  const quoted = await send("ana", ids.general, "Alguém já testou o canal de voz?");
  await send("bruno", ids.general, "Testei ontem, o áudio ficou ótimo.", { reply_to: quoted });
  await send("carla", ids.general, `@${people.ana.username} você viu o convite novo?`);
  const pinned = await send(
    "ana",
    ids.general,
    "Regra da casa: seja gentil e use os canais certos.",
  );
  await people.ana.ctx.request.put(`/api/channels/${ids.general}/pins/${pinned}`);
  const img = await attach("carla", ids.general, "paisagem.png", "image/png", makePng(960, 600));
  await send("carla", ids.general, "Foto do protótipo", { attachment_ids: [img] });
  const file = await attach(
    "bruno",
    ids.general,
    "relatorio-fase-4.pdf",
    "application/pdf",
    Buffer.from("%PDF-1.4\n% relatório de exemplo\n".repeat(400)),
  );
  await send("bruno", ids.general, "Segue o relatório", { attachment_ids: [file] });
  await send("ana", ids.dev, "Deploy de hoje saiu sem problemas.");

  // não lidas e menções para a Ana (ela não abriu esses canais)
  await send("bruno", ids.dev, "Novo PR aberto: refatora o store de mensagens.");
  await send("carla", ids.dev, `@${people.ana.username} pode revisar o PR do Bruno?`);
  await send("carla", ids.dev, "Obrigada!");

  // DM
  const dm = await json<{ id: string }>(
    await people.bruno.ctx.request.post("/api/users/@me/channels", {
      data: { recipient_id: people.ana.id },
    }),
  );
  dmWithBruno = dm.id;
  await send("bruno", dmWithBruno, "Oi, Ana! Tem um minuto?");
  await send("bruno", dmWithBruno, "Queria combinar a demo de sexta.");
  await send("ana", dmWithBruno, "Claro, pode falar.");
  const dm2 = await json<{ id: string }>(
    await people.carla.ctx.request.post("/api/users/@me/channels", {
      data: { recipient_id: people.ana.id },
    }),
  );
  await send("carla", dm2.id, "Mandei o arquivo por aqui.");
  const group = await json<{ id: string }>(
    await people.ana.ctx.request.post("/api/users/@me/channels", {
      data: { recipient_ids: [people.bruno.id, people.carla.id] },
    }),
  );
  dmGroup = group.id;
  await people.ana.ctx.request.patch(`/api/channels/${dmGroup}`, {
    data: { name: "Estudo de Go" },
  });
  await send("bruno", dmGroup, "Bora marcar o próximo encontro do grupo?");
}

async function newPass(
  browser: Browser,
  vp: (typeof VIEWPORTS)[number],
  theme: (typeof THEMES)[number],
  who: Who | null,
) {
  const state = who ? await people[who].ctx.storageState() : undefined;
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    storageState: state,
    isMobile: vp.width < 600,
    hasTouch: vp.width < 600,
    reducedMotion: "reduce",
    permissions: ["microphone", "camera", "clipboard-read", "clipboard-write"],
  });
  await ctx.addInitScript((t) => {
    try {
      localStorage.setItem("spook-theme", t === "escuro" ? "dark" : "light");
    } catch {
      /* ignora */
    }
  }, theme);
  return ctx;
}

/** Espera o app estabilizar e salva o PNG como NN-tela-tema-viewport.png. */
async function shot(page: Page, screen: string, theme: string, vp: string) {
  const fixed = FIXED_NUMBERS[screen];
  if (fixed === undefined && !numbers.has(screen)) numbers.set(screen, numbers.size + 1);
  if (ONLY && !ONLY.split(",").some((k) => screen.includes(k.trim()))) return;
  const name = `${String(fixed ?? numbers.get(screen)).padStart(2, "0")}-${screen}-${theme}-${vp}.png`;
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(outDir, name), animations: "disabled" });
}

/** Executa um passo de captura; se falhar, registra e segue (a captura é "o que for possível"). */
async function step(label: string, vp: string, theme: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (e) {
    failures.push(
      `${label} (${theme}, ${vp}): ${String(e)
        .replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "")
        .split("\n")
        .filter(Boolean)
        .slice(0, 3)
        .join(" | ")
        .slice(0, 260)}`,
    );
  }
}

async function open(page: Page, url: string) {
  await page.goto(url);
  await page.waitForLoadState("domcontentloaded");
}

/** Em 390 px a navegação é um drawer: abre se estiver fechado (idempotente). */
async function openNav(page: Page, vp: (typeof VIEWPORTS)[number]) {
  if (vp.width >= 768) return;
  const drawer = page.getByRole("dialog", { name: "Navegação", includeHidden: true });
  if ((await drawer.getAttribute("data-state")) === "open") return;
  await page.getByRole("button", { name: "Abrir menu de navegação" }).first().click();
  await page.waitForTimeout(350);
}

const chUrl = (id: string) => `/channels/${guildId}/${id}`;

test("captura de telas", async ({ browser }) => {
  mkdirSync(outDir, { recursive: true });
  await setup(browser);

  // B e C ficam conectados na voz numa janela própria, entrando só quando a Ana já está lá.
  const bCtx = await newPass(browser, VIEWPORTS[0], "escuro", "bruno");
  const cCtx = await newPass(browser, VIEWPORTS[0], "escuro", "carla");
  const bPage = await bCtx.newPage();
  const cPage = await cCtx.newPage();

  for (const theme of THEMES) {
    for (const vp of VIEWPORTS) {
      const vk = vp.key;

      // ---- públicas ----
      const anon = await newPass(browser, vp, theme, null);
      const ap = await anon.newPage();
      await step("login", vk, theme, async () => {
        await open(ap, "/login");
        await expect(ap.getByLabel("E-mail")).toBeVisible();
        await shot(ap, "login", theme, vk);
      });
      await step("login-erro", vk, theme, async () => {
        await ap.getByLabel("E-mail").fill("ninguem@spook.dev");
        await ap.getByLabel("Senha", { exact: true }).fill("senha-errada-123");
        await ap
          .getByRole("button", { name: /entrar/i })
          .first()
          .click();
        await ap.waitForTimeout(800);
        await shot(ap, "login-erro", theme, vk);
      });
      await step("cadastro", vk, theme, async () => {
        await open(ap, "/register");
        await expect(ap.getByLabel("E-mail")).toBeVisible();
        await shot(ap, "cadastro", theme, vk);
      });
      await step("convite-deslogado", vk, theme, async () => {
        await open(ap, `/invite/${inviteCode}`);
        await shot(ap, "convite-deslogado", theme, vk);
      });
      await step("404-deslogado", vk, theme, async () => {
        await open(ap, "/rota-que-nao-existe");
        await shot(ap, "404", theme, vk);
      });
      await anon.close();

      // ---- Ana (dona/admin) ----
      const ctx = await newPass(browser, vp, theme, "ana");
      const page = await ctx.newPage();

      // Home sem servidor: conta nova sem servidores.
      await step("home-sem-servidor", vk, theme, async () => {
        const lone = await register(browser, `solo${theme[0]}${vk}`, "Dani Souza").catch(
          () => null,
        );
        if (!lone) throw new Error("registro extra falhou");
        const c = await browser.newContext({
          viewport: { width: vp.width, height: vp.height },
          storageState: await lone.ctx.storageState(),
        });
        await c.addInitScript(
          (t) => localStorage.setItem("spook-theme", t === "escuro" ? "dark" : "light"),
          theme,
        );
        const p = await c.newPage();
        await open(p, "/");
        await p.waitForTimeout(600);
        await shot(p, "home-sem-servidor", theme, vk);
        await step("dialogo-criar-servidor", vk, theme, async () => {
          await p.getByRole("button", { name: "Criar servidor" }).first().click();
          await shot(p, "dialogo-criar-servidor", theme, vk);
        });
        await c.close();
        await lone.ctx.close();
      });

      await step("canal-vazio", vk, theme, async () => {
        await open(page, chUrl(ids.empty));
        await shot(page, "canal-texto-vazio", theme, vk);
      });
      // Não lidas: a Ana abre o servidor num canal e vê o outro com marcação.
      await step("canal-nao-lidas", vk, theme, async () => {
        await open(page, chUrl(ids.general));
        await expect(page.getByRole("log").first()).toBeVisible();
        await shot(page, "canal-texto-mensagens", theme, vk);
      });
      await step("canal-rolado-topo", vk, theme, async () => {
        const log = page.getByRole("log").first();
        await log.evaluate((el) => {
          const sc = [el, ...el.querySelectorAll("*")].find(
            (n) => n.scrollHeight > n.clientHeight + 4,
          ) as HTMLElement | undefined;
          if (sc) sc.scrollTop = 0;
        });
        await page.waitForTimeout(400);
        await shot(page, "canal-texto-topo-mensagens-antigas", theme, vk);
      });
      await step("membros", vk, theme, async () => {
        const members = page.getByRole("complementary", { name: "Membros" });
        if (
          !(await members
            .first()
            .isVisible()
            .catch(() => false))
        ) {
          await page
            .getByRole("button", { name: /membros/i })
            .first()
            .click();
        }
        await shot(page, "lista-de-membros", theme, vk);
      });
      await step("menu-mensagem", vk, theme, async () => {
        await open(page, chUrl(ids.general));
        const row = page
          .getByRole("article")
          .first()
          .or(page.locator("[aria-label^='Mensagem de']").first());
        await row.hover();
        await shot(page, "mensagem-hover", theme, vk);
      });
      await step("composer-resposta", vk, theme, async () => {
        const row = page.locator("[aria-label^='Mensagem de']").nth(3);
        await row.hover();
        if (vp.width >= 768) await row.getByRole("button", { name: "Responder" }).click();
        else {
          await row.getByRole("button", { name: /^Ações da mensagem de/ }).click();
          await page.getByRole("menuitem", { name: "Responder" }).click();
        }
        await page
          .getByLabel(/Mensagem em #/)
          .fill("Rascunho de uma resposta que ainda não foi enviada");
        await shot(page, "composer-respondendo", theme, vk);
      });
      await step("fixadas", vk, theme, async () => {
        await open(page, chUrl(ids.general));
        await page
          .getByRole("button", { name: /fixadas/i })
          .first()
          .click();
        await shot(page, "mensagens-fixadas", theme, vk);
      });
      await step("canal-dev-menções", vk, theme, async () => {
        await open(page, chUrl(ids.dev));
        await shot(page, "canal-texto-com-mencao", theme, vk);
      });

      // Chat e membros (repaginação: etapas d/e)
      await step("chat-lightbox", vk, theme, async () => {
        await open(page, chUrl(ids.general));
        await page
          .getByRole("button", { name: /^Abrir imagem/ })
          .first()
          .click();
        await expect(page.getByRole("dialog")).toBeVisible();
        await page.waitForTimeout(400);
        await shot(page, "chat-lightbox", theme, vk);
        await page.keyboard.press("Escape");
      });
      await step("chat-cartao-perfil", vk, theme, async () => {
        await open(page, chUrl(ids.general));
        await page
          .getByRole("log")
          .first()
          .getByRole("button", { name: /^Ver perfil de/ })
          .first()
          .click();
        await expect(page.getByTestId("profile-card")).toBeVisible();
        await shot(page, "chat-cartao-perfil", theme, vk);
        await page.keyboard.press("Escape");
      });
      await step("chat-acoes", vk, theme, async () => {
        await open(page, chUrl(ids.general));
        const row = page.locator("article[aria-label^='Mensagem de']").nth(-3);
        if (vp.width >= 768) {
          await row.hover();
          await row.getByRole("button", { name: "Responder" }).focus();
          await shot(page, "chat-acoes-hover", theme, vk);
        } else {
          await row.scrollIntoViewIfNeeded();
          await row.getByRole("button", { name: /^Ações da mensagem de/ }).click();
          await expect(page.getByRole("menuitem", { name: "Responder" })).toBeVisible();
          await shot(page, "chat-acoes-toque", theme, vk);
          await page.keyboard.press("Escape");
        }
      });
      await step("chat-composer-anexos", vk, theme, async () => {
        await open(page, chUrl(ids.general));
        await page.route(/:3900\//, (route) =>
          // só o envio (PUT/OPTIONS) é simulado; as imagens já enviadas continuam vindo do Garage
          route.request().method() === "GET"
            ? route.continue()
            : route.fulfill({
                status: 200,
                headers: {
                  "access-control-allow-origin": "*",
                  "access-control-allow-headers": "*",
                  "access-control-allow-methods": "*",
                },
              }),
        );
        await page.getByTestId("attachment-input").setInputFiles([
          { name: "paisagem.png", mimeType: "image/png", buffer: makePng(640, 400) },
          {
            name: "relatorio.pdf",
            mimeType: "application/pdf",
            buffer: Buffer.from("%PDF-1.4\n".repeat(300)),
          },
        ]);
        await page.getByLabel(/Mensagem em #/).fill("Segue o material da reunião");
        await page.waitForTimeout(600);
        await shot(page, "chat-composer-anexos", theme, vk);
        await page.unroute(/:3900\//);
      });
      await step("chat-membros-grupos", vk, theme, async () => {
        await open(page, chUrl(ids.general));
        const members = page.getByRole("complementary", { name: "Membros" });
        if (
          !(await members
            .first()
            .isVisible()
            .catch(() => false))
        ) {
          await page
            .getByRole("button", { name: /membros/i })
            .first()
            .click();
        }
        await page.waitForTimeout(400);
        await shot(page, "chat-membros-grupos", theme, vk);
      });

      // Barra de servidores e lista de canais (repaginação: etapas b/c/d)
      await step("rail-hover", vk, theme, async () => {
        await open(page, chUrl(ids.general));
        await expect(page.getByRole("log").first()).toBeVisible();
        if (vp.width >= 768) {
          await page
            .getByRole("navigation", { name: "Servidores" })
            .getByRole("link")
            .nth(1)
            .hover();
          await page.waitForTimeout(400);
          await shot(page, "barra-servidores-hover", theme, vk);
        }
      });
      await step("categoria-recolhida", vk, theme, async () => {
        const nav = page.getByRole("navigation", { name: "Canais" });
        if (vp.width < 768) {
          await page.getByRole("button", { name: "Abrir menu de navegação" }).click();
          await page.waitForTimeout(400);
          await shot(page, "drawer-aberto", theme, vk);
        }
        await nav
          .getByRole("button", { name: /^(Canais|Texto)/i })
          .first()
          .click();
        await page.waitForTimeout(300);
        await shot(page, "categoria-recolhida", theme, vk);
        await nav
          .getByRole("button", { name: /^(Canais|Texto)/i })
          .first()
          .click();
        if (vp.width < 768) await page.keyboard.press("Escape");
      });
      await step("drawer-dms", vk, theme, async () => {
        await open(page, "/channels/@me");
        if (vp.width < 768) {
          await page.getByRole("button", { name: "Abrir menu de navegação" }).first().click();
          await page.waitForTimeout(400);
          await shot(page, "drawer-dms", theme, vk);
        }
      });
      await step("membros-sheet", vk, theme, async () => {
        await open(page, chUrl(ids.general));
        if (vp.width < 1024) {
          await page.getByRole("button", { name: "Mostrar membros" }).click();
          await page.waitForTimeout(400);
          await shot(page, "membros-sheet", theme, vk);
        }
      });

      // Diálogos do servidor
      await step("menu-servidor", vk, theme, async () => {
        await open(page, chUrl(ids.general));
        await openNav(page, vp);
        await page
          .getByRole("button", { name: /Menu do servidor/ })
          .first()
          .click();
        await shot(page, "menu-do-servidor", theme, vk);
      });
      await step("convite", vk, theme, async () => {
        await page.getByRole("menuitem", { name: /Convidar pessoas/ }).click();
        await page.waitForTimeout(600);
        await shot(page, "dialogo-convite", theme, vk);
        await page.addStyleTag({ content: "[data-sonner-toaster]{display:none!important}" });
        await page
          .getByRole("button", { name: /^Copiar link do convite/ })
          .first()
          .click()
          .catch(() => undefined);
        await page.waitForTimeout(300);
        await shot(page, "dialogo-convite-copiado", theme, vk);
        await page.keyboard.press("Escape");
      });
      await step("cargos", vk, theme, async () => {
        await page
          .getByRole("button", { name: /Menu do servidor/ })
          .first()
          .click();
        await page.getByRole("menuitem", { name: /^Cargos/ }).click();
        await page.waitForTimeout(600);
        await shot(page, "dialogo-cargos", theme, vk);
        await page
          .getByRole("list", { name: "Cargos" })
          .getByRole("button")
          .first()
          .click()
          .catch(() => undefined);
        await page.waitForTimeout(300);
        await shot(page, "dialogo-cargos-permissoes", theme, vk);
        await page.keyboard.press("Escape");
      });
      await step("config-servidor", vk, theme, async () => {
        await page
          .getByRole("button", { name: /Menu do servidor/ })
          .first()
          .click();
        await page.getByRole("menuitem", { name: /Configurações do servidor/ }).click();
        await page.waitForTimeout(600);
        await shot(page, "dialogo-configuracoes-servidor", theme, vk);
        await page.keyboard.press("Escape");
      });
      await step("criar-canal", vk, theme, async () => {
        await openNav(page, vp);
        await page
          .getByRole("button", { name: /Menu do servidor/ })
          .first()
          .click();
        await page.getByRole("menuitem", { name: /Criar canal/ }).click();
        await page.waitForTimeout(400);
        await shot(page, "dialogo-criar-canal", theme, vk);
        await page.keyboard.press("Escape");
      });
      await step("adicionar-servidor", vk, theme, async () => {
        await openNav(page, vp);
        await page.getByRole("button", { name: "Adicionar um servidor" }).click();
        await shot(page, "dialogo-adicionar-servidor", theme, vk);
        await page.keyboard.press("Escape");
      });
      await step("membro-opcoes", vk, theme, async () => {
        await openNav(page, vp);
        await page
          .getByRole("button", { name: /^Opções de / })
          .first()
          .click();
        await shot(page, "menu-de-membro", theme, vk);
        await page.keyboard.press("Escape");
      });

      // DMs
      await step("dm-lista", vk, theme, async () => {
        await open(page, "/channels/@me");
        await shot(page, "dms-lista", theme, vk);
      });
      await step("dm-conversa", vk, theme, async () => {
        await open(page, `/channels/@me/${dmWithBruno}`);
        await expect(page.getByRole("log").first()).toBeVisible();
        await shot(page, "dm-conversa", theme, vk);
      });
      await step("dm-grupo-conversa", vk, theme, async () => {
        await open(page, `/channels/@me/${dmGroup}`);
        await expect(page.getByRole("log").first()).toBeVisible();
        await shot(page, "dm-grupo-conversa", theme, vk);
        await page.getByRole("button", { name: /^Participantes/ }).click();
        await page.waitForTimeout(500);
        await shot(page, "dialogo-participantes", theme, vk);
        await page.keyboard.press("Escape");
      });
      await step("dm-grupo", vk, theme, async () => {
        await open(page, "/channels/@me");
        await openNav(page, vp);
        await page.getByRole("button", { name: "Nova conversa em grupo" }).click();
        await shot(page, "dialogo-novo-grupo", theme, vk);
        await page.keyboard.press("Escape");
      });

      // Perfil e configurações
      for (const [route, key] of [
        ["/settings/profile", "perfil"],
        ["/settings/notifications", "notificacoes"],
        ["/settings/app", "config-app"],
      ] as const) {
        await step(key, vk, theme, async () => {
          await open(page, route);
          await page.waitForTimeout(400);
          await shot(page, key, theme, vk);
        });
      }
      await step("painel-usuario", vk, theme, async () => {
        await open(page, chUrl(ids.general));
        await openNav(page, vp);
        await page
          .getByRole("button", { name: /status|presença/i })
          .first()
          .click();
        await shot(page, "menu-de-status", theme, vk);
        await page.keyboard.press("Escape");
      });

      // Erro / 404 logado
      await step("404", vk, theme, async () => {
        await open(page, "/rota-que-nao-existe");
        await shot(page, "404-logado", theme, vk);
      });
      await step("servidor-inexistente", vk, theme, async () => {
        await open(page, "/channels/1/1");
        await page.waitForTimeout(600);
        await shot(page, "erro-servidor-inexistente", theme, vk);
      });
      await step("convite-invalido", vk, theme, async () => {
        await open(page, "/invite/codigo-invalido");
        await page.waitForTimeout(600);
        await shot(page, "convite-invalido", theme, vk);
      });
      await step("convite-logado", vk, theme, async () => {
        const inv = await json<{ code: string }>(
          await people.ana.ctx.request.post(`/api/guilds/${guildId}/invites`, { data: {} }),
        );
        const other = await browser.newContext({
          viewport: { width: vp.width, height: vp.height },
        });
        await other.close();
        await open(page, `/invite/${inv.code}`);
        await page.waitForTimeout(600);
        await shot(page, "convite-ja-membro", theme, vk);
      });

      // Admin
      for (const [route, key] of [
        ["/admin", "admin-dashboard"],
        ["/admin/users", "admin-usuarios"],
        ["/admin/servers", "admin-servidores"],
        ["/admin/calls", "admin-chamadas"],
      ] as const) {
        await step(key, vk, theme, async () => {
          await open(page, route);
          await page.waitForTimeout(800);
          await shot(page, key, theme, vk);
        });
      }

      // Voz: sozinho, com outras pessoas, câmera e tela.
      const voiceBtn = (p: Page) =>
        p
          .getByRole("navigation", { name: "Canais" })
          .getByRole("button", { name: /Sala de estudos \(canal de voz/ });
      // acorda a barra flutuante do palco (ela some após ~3 s sem movimento do mouse)
      const wake = async (p: Page) => {
        await p.mouse.move(vp.width / 2, vp.height / 2);
        await p.mouse.move(vp.width / 2 + 8, vp.height / 2 + 8);
      };
      await step("voz-sozinho", vk, theme, async () => {
        await open(page, chUrl(ids.general));
        await openNav(page, vp);
        await voiceBtn(page).click();
        await expect(page.getByText("Voz conectada")).toBeVisible({ timeout: 25_000 });
        if (vp.width < 768) await page.keyboard.press("Escape").catch(() => undefined);
        await page.waitForTimeout(800);
        await wake(page);
        await shot(page, "voz-sozinho", theme, vk);
        await shot(page, "voz-tile-convite", theme, vk);
        await page.waitForTimeout(3600); // ociosidade: a barra some
        await shot(page, "voz-barra-oculta", theme, vk);
      });
      await step("voz-varios", vk, theme, async () => {
        for (const [p, name] of [
          [bPage, "bruno"],
          [cPage, "carla"],
        ] as const) {
          await open(p, chUrl(ids.general));
          await voiceBtn(p).click();
          await expect(p.getByText("Voz conectada")).toBeVisible({ timeout: 25_000 });
          void name;
        }
        await expect(page.getByText("3 pessoas")).toBeVisible({ timeout: 20_000 });
        await page.waitForTimeout(1500);
        await wake(page);
        await shot(page, "voz-com-outras-pessoas", theme, vk);
      });
      await step("voz-camera", vk, theme, async () => {
        await openNav(page, vp);
        const bar = page.getByRole("region", { name: "Controles de voz" });
        await bar.getByRole("button", { name: "Ligar câmera" }).click();
        await bPage
          .getByRole("region", { name: "Controles de voz" })
          .getByRole("button", { name: "Ligar câmera" })
          .click();
        await page.waitForTimeout(3000);
        if (vp.width < 768) {
          await page.mouse.click(vp.width - 10, 300); // toque na área escura fecha o drawer
          await page.waitForTimeout(500);
        }
        await wake(page);
        await shot(page, "voz-com-camera", theme, vk);
      });
      await step("voz-tela", vk, theme, async () => {
        await bPage
          .getByRole("region", { name: "Controles de voz" })
          .getByRole("button", { name: "Compartilhar tela" })
          .click();
        await bPage.getByRole("button", { name: "Compartilhar", exact: true }).click();
        await page.waitForTimeout(4000);
        await wake(page);
        await shot(page, "voz-tela-compartilhada", theme, vk);
      });
      await step("voz-foco", vk, theme, async () => {
        // destaca a tela do Bruno (tile grande + tira) e abre o menu do tile
        await page.getByRole("button", { name: /Destacar tela de/ }).click();
        await page.waitForTimeout(600);
        await wake(page);
        await shot(page, "voz-foco", theme, vk);
        await shot(page, "voz-barra-visivel", theme, vk);
        await page.getByRole("button", { name: /^Opções de Tela de/ }).click();
        await page.waitForTimeout(400);
        await shot(page, "voz-menu-do-tile", theme, vk);
        await page.keyboard.press("Escape");
        await page.keyboard.press("Escape");
      });
      await step("voz-dispositivos", vk, theme, async () => {
        await openNav(page, vp);
        await page
          .getByRole("region", { name: "Controles de voz" })
          .getByRole("button", {
            name: /dispositivos|configurações de áudio|Configurações de voz/i,
          })
          .first()
          .click();
        await shot(page, "dialogo-dispositivos-voz", theme, vk);
        await page.keyboard.press("Escape");
      });
      // Configurações (etapa g): seções novas e, no celular, a lista de seções.
      for (const [route, key] of [
        ["/settings/voice", "config-voz-e-video"],
        ["/settings/appearance", "config-aparencia"],
      ] as const) {
        await step(key, vk, theme, async () => {
          await open(page, route);
          await page.waitForTimeout(400);
          await shot(page, key, theme, vk);
        });
      }
      if (vk === "390") {
        await step("config-lista", vk, theme, async () => {
          await open(page, "/settings");
          await page.waitForTimeout(400);
          await shot(page, "config-lista", theme, vk);
        });
      }
      // sai de todo mundo para a próxima combinação
      for (const p of [page, bPage, cPage]) {
        await p
          .getByRole("button", { name: "Sair da chamada" })
          .click({ timeout: 3000 })
          .catch(() => undefined);
      }
      await ctx.close();
    }
  }

  writeFileSync(
    join(outDir, "_falhas.txt"),
    failures.length ? `${failures.join("\n")}\n` : "Nenhuma falha.\n",
  );
  await bCtx.close();
  await cCtx.close();
});
