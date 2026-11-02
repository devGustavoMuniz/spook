import { deflateSync } from "node:zlib";
import {
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  expect,
  type Page,
  test,
} from "@playwright/test";

// Fase 6: anexos e miniaturas, não lidas, menções, avisos in-app e a inscrição de push (simulada),
// com duas contas em contextos separados, contra o backend real. Anexos exigem o Garage e o worker do
// River no backend (o thumbnail chega por MESSAGE_UPDATE); veja "Anexos no E2E" em apps/web/README.md.

const PASSWORD = "senha-forte-123";
const run = Date.now().toString(36);

type Who = "a" | "b";
const username = (who: Who) => `e2e_f6_${who}_${run}`.slice(0, 32);

type Person = { ctx: BrowserContext; page: Page };

const sessions: Partial<Record<Who, Awaited<ReturnType<BrowserContext["storageState"]>>>> = {};
const ids: Partial<Record<Who, string>> = {};
let guildId = "";
let guildName = "";
let generalId = "";
let devId = "";

async function json<T>(
  res: Awaited<ReturnType<APIRequestContext["get"]>>,
  status: number,
): Promise<T> {
  expect(res.status(), await res.text()).toBe(status);
  return (await res.json()) as T;
}

test.beforeAll(async ({ browser }) => {
  const people: Partial<Record<Who, BrowserContext>> = {};
  for (const who of ["a", "b"] as const) {
    const ctx = await browser.newContext();
    const res = await json<{ user: { id: string } }>(
      await ctx.request.post("/api/auth/register", {
        data: {
          email: `e2e-f6-${who}-${run}@spook.dev`,
          username: username(who),
          password: PASSWORD,
        },
      }),
      201,
    );
    ids[who] = res.user.id;
    sessions[who] = await ctx.storageState();
    people[who] = ctx;
  }
  const a = people.a as BrowserContext;
  guildName = "Servidor Fase 6";
  const guild = await json<{ id: string; channels: { id: string; type: number }[] }>(
    await a.request.post("/api/guilds", { data: { name: guildName } }),
    201,
  );
  guildId = guild.id;
  generalId = guild.channels.find((c) => c.type === 0)?.id ?? "";
  const dev = await json<{ id: string }>(
    await a.request.post(`/api/guilds/${guild.id}/channels`, { data: { name: "dev", type: 0 } }),
    201,
  );
  devId = dev.id;
  const invite = await json<{ code: string }>(
    await a.request.post(`/api/guilds/${guild.id}/invites`, { data: {} }),
    201,
  );
  await json(await (people.b as BrowserContext).request.post(`/api/invites/${invite.code}`), 200);
  for (const ctx of Object.values(people)) await ctx?.close();
});

async function person(browser: Browser, who: Who): Promise<Person> {
  const ctx = await browser.newContext({ storageState: sessions[who] });
  return { ctx, page: await ctx.newPage() };
}

/** Abre uma URL e espera o READY: a partir daí a pessoa está online e assinou os tópicos. */
async function open(p: Person, url: string) {
  const ready = p.page.waitForEvent("websocket", (ws) => ws.url().includes("/api/gateway"));
  await p.page.goto(url);
  const ws = await ready;
  await ws.waitForEvent("framereceived", (f) => String(f.payload).includes('"READY"'));
}

const channelUrl = (channelId: string) => `/channels/${guildId}/${channelId}`;
const log = (p: Person, channel: string) =>
  p.page.getByRole("log", { name: `Mensagens de ${channel}` });
const sidebar = (p: Person) => p.page.getByRole("navigation", { name: "Canais" });
const rail = (p: Person) => p.page.getByRole("navigation", { name: "Servidores" });

// ---- imagens geradas na hora (PNG válido, sem dependências) ----

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

/** PNG RGB com um gradiente (largura x altura). */
function makePng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8 bits
  ihdr[9] = 2; // RGB
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3); // filtro 0 + pixels
    for (let x = 0; x < width; x++) {
      row[1 + x * 3] = (x * 255) / width;
      row[2 + x * 3] = (y * 255) / height;
      row[3 + x * 3] = (x * y) % 256;
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

test("A anexa uma imagem: progresso, mensagem para os dois lados e o thumbnail chega por MESSAGE_UPDATE", async ({
  browser,
}) => {
  const a = await person(browser, "a");
  const b = await person(browser, "b");
  await open(b, channelUrl(generalId));
  await open(a, channelUrl(generalId));

  // Atrasa o PUT no storage para dar para ver o progresso (o arquivo é pequeno e passaria voando).
  await a.page.route(/\/attachments\/.*\.png/, async (route) => {
    if (route.request().method() === "PUT") await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });

  await a.page.getByTestId("attachment-input").setInputFiles({
    name: "paisagem.png",
    mimeType: "image/png",
    buffer: makePng(900, 600),
  });
  const pending = a.page.getByRole("list", { name: "Anexos pendentes" });
  await expect(pending.getByText("paisagem.png")).toBeVisible();
  await expect(pending.getByRole("progressbar", { name: "Enviando paisagem.png" })).toBeVisible();
  // só envia quando todos terminarem
  await expect(a.page.getByRole("button", { name: "Enviar mensagem" })).toBeDisabled();
  await expect(pending.getByText("Pronto")).toBeVisible({ timeout: 15_000 });
  await a.page.getByLabel("Mensagem em #geral").fill("olha a paisagem");
  await a.page.getByRole("button", { name: "Enviar mensagem" }).click();
  await expect(pending).toHaveCount(0);

  // aparece para os dois, sem recarregar
  const imgA = log(a, "geral").getByRole("img", { name: "paisagem.png" });
  const imgB = log(b, "geral").getByRole("img", { name: "paisagem.png" });
  await expect(imgA).toBeVisible();
  await expect(imgB).toBeVisible();
  await expect(log(b, "geral").getByText("olha a paisagem")).toBeVisible();

  // o job do River gera o thumbnail e o MESSAGE_UPDATE troca a imagem nos dois lados
  await expect(imgA).toHaveAttribute("src", /thumbnails\//, { timeout: 30_000 });
  await expect(imgB).toHaveAttribute("src", /thumbnails\//, { timeout: 30_000 });
  await expect
    .poll(() => imgB.evaluate((el: HTMLImageElement) => el.naturalWidth), { timeout: 10_000 })
    .toBeGreaterThan(0);
  // proporção reservada (900x600 = 3:2)
  const box = await imgB.locator("xpath=..").boundingBox();
  expect((box?.width ?? 0) / (box?.height ?? 1)).toBeCloseTo(1.5, 1);

  // visualizador: abre ao clicar (com o original), fecha com Esc e devolve o foco
  const trigger = log(b, "geral").getByRole("button", { name: "Abrir imagem paisagem.png" });
  await trigger.click();
  const dialog = b.page.getByRole("dialog", { name: "Imagem paisagem.png" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("img", { name: "paisagem.png" })).toHaveAttribute(
    "src",
    /attachments\//,
  );
  await b.page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();

  await a.ctx.close();
  await b.ctx.close();
});

test("arquivo comum vira cartão para os dois; acima de 25 MB e tipo proibido são recusados com mensagem", async ({
  browser,
}) => {
  const a = await person(browser, "a");
  const b = await person(browser, "b");
  await open(b, channelUrl(generalId));
  await open(a, channelUrl(generalId));
  const input = a.page.getByTestId("attachment-input");

  // recusas no cliente: nada chega a pedir upload
  await input.setInputFiles({
    name: "enorme.zip",
    mimeType: "application/zip",
    buffer: Buffer.alloc(26 * 1024 * 1024 + 1),
  });
  await expect(a.page.getByText(/"enorme.zip" passa do limite de 25 MB/)).toBeVisible();
  await input.setInputFiles({
    name: "desenho.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"),
  });
  await expect(
    a.page.getByText(/"desenho.svg": este tipo de arquivo não é permitido/),
  ).toBeVisible();
  await expect(a.page.getByRole("list", { name: "Anexos pendentes" })).toHaveCount(0);

  // recusa no servidor: um texto disfarçado de PNG é enviado ao storage, mas a mensagem é recusada
  await input.setInputFiles({
    name: "falso.png",
    mimeType: "image/png",
    buffer: Buffer.from("isto é só texto, não uma imagem"),
  });
  const pending = a.page.getByRole("list", { name: "Anexos pendentes" });
  await expect(pending.getByText("Pronto")).toBeVisible({ timeout: 15_000 });
  await a.page.getByRole("button", { name: "Enviar mensagem" }).click();
  await expect(a.page.getByText(/Anexo recusado/)).toBeVisible();
  await expect(pending.getByText("Envie este arquivo de novo.")).toBeVisible();
  await pending.getByRole("button", { name: "Remover falso.png" }).click();

  // arquivo comum: cartão com nome, tamanho e baixar para os dois lados
  await input.setInputFiles({
    name: "notas.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("anotações da reunião"),
  });
  await expect(pending.getByText("Pronto")).toBeVisible({ timeout: 15_000 });
  await a.page.getByRole("button", { name: "Enviar mensagem" }).click();
  for (const p of [a, b]) {
    const card = log(p, "geral").getByRole("link", { name: "Baixar notas.txt" });
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute("href", /attachments\//);
    await expect(log(p, "geral").getByText("notas.txt", { exact: true })).toBeVisible();
  }

  await a.ctx.close();
  await b.ctx.close();
});

test("não lidas: B vê o indicador quando A escreve em outro canal e ele some ao abrir, inclusive após recarregar", async ({
  browser,
}) => {
  const a = await person(browser, "a");
  const b = await person(browser, "b");
  await open(b, channelUrl(generalId));
  await open(a, channelUrl(devId));

  const composer = a.page.getByLabel("Mensagem em #dev");
  await composer.fill("primeira em dev");
  await composer.press("Enter");

  const dot = sidebar(b).getByRole("img", { name: "Mensagens novas em #dev" });
  await expect(dot).toBeVisible();
  await expect(sidebar(b).getByRole("link", { name: /dev/ })).toHaveClass(/font-semibold/);

  await sidebar(b).getByRole("link", { name: /dev/ }).click();
  await expect(log(b, "dev").getByText("primeira em dev")).toBeVisible();
  await expect(dot).toHaveCount(0);

  // o ack chegou ao servidor: recarregar não traz o indicador de volta
  await b.page.reload();
  await expect(log(b, "dev").getByText("primeira em dev")).toBeVisible();
  await expect(sidebar(b).getByRole("img", { name: /em #dev/ })).toHaveCount(0);

  // mensagem com o canal aberto e visível não vira não lida
  await composer.fill("segunda em dev");
  await composer.press("Enter");
  await expect(log(b, "dev").getByText("segunda em dev")).toBeVisible();
  await expect(sidebar(b).getByRole("img", { name: /em #dev/ })).toHaveCount(0);

  await a.ctx.close();
  await b.ctx.close();
});

test("menção: B vê destaque, contador, título da aba e toast; o clique leva ao canal", async ({
  browser,
}) => {
  const a = await person(browser, "a");
  const b = await person(browser, "b");
  await open(b, channelUrl(generalId));
  await open(a, channelUrl(devId));

  const composer = a.page.getByLabel("Mensagem em #dev");
  await composer.fill(`e aí @${username("b")}, viu isso?`);
  await composer.press("Enter");

  // aviso in-app (toast) com o autor, o canal e o servidor
  const toast = b.page.getByText(`${username("a")} (#dev · ${guildName})`);
  await expect(toast).toBeVisible();
  await expect(sidebar(b).getByRole("img", { name: "1 menção em #dev" })).toBeVisible();
  await expect(rail(b).getByRole("img", { name: `1 menção em ${guildName}` })).toBeVisible();
  await expect(b.page).toHaveTitle("(1) Spook");

  await b.page.getByRole("button", { name: "Abrir", exact: true }).click();
  await expect(b.page).toHaveURL(new RegExp(`/channels/${guildId}/${devId}$`));
  const message = log(b, "dev").getByRole("article").filter({ hasText: "viu isso?" });
  await expect(message).toHaveAttribute("data-mention", "true");
  await expect(message.locator("mark")).toHaveText(`@${username("b")}`);

  // abrir o canal acusa a leitura: contador e título voltam ao normal
  await expect(sidebar(b).getByRole("img", { name: /em #dev/ })).toHaveCount(0);
  await expect(b.page).toHaveTitle("Spook");

  await a.ctx.close();
  await b.ctx.close();
});

test("DM fora de vista: badge no Início, toast e silenciar notificações", async ({ browser }) => {
  const a = await person(browser, "a");
  const b = await person(browser, "b");
  const dm = await json<{ id: string }>(
    await a.ctx.request.post("/api/users/@me/channels", { data: { recipient_id: ids.b } }),
    201,
  ).catch(async () =>
    json<{ id: string }>(
      await a.ctx.request.post("/api/users/@me/channels", { data: { recipient_id: ids.b } }),
      200,
    ),
  );
  await open(b, channelUrl(generalId));
  await open(a, `/channels/@me/${dm.id}`);

  const composer = a.page.getByLabel(`Mensagem para ${username("b")}`);
  await composer.fill("psiu, tem um minuto?");
  await composer.press("Enter");
  await expect(b.page.getByText("psiu, tem um minuto?")).toBeVisible(); // toast
  await expect(rail(b).getByRole("img", { name: "1 mensagens diretas não lidas" })).toBeVisible();
  await expect(b.page).toHaveTitle("(1) Spook");

  // silenciado: sem toast novo (a contagem segue)
  await b.page.goto("/settings/notifications");
  await b.page.getByRole("switch", { name: /Silenciar notificações/ }).click();
  await b.page.getByRole("button", { name: "Fechar configurações" }).click();
  await b.page.getByRole("link", { name: "Início" }).first().click();
  await expect(b.page.getByRole("heading", { name: "Mensagens diretas" })).toBeVisible();
  await composer.fill("segunda mensagem");
  await composer.press("Enter");
  await expect(rail(b).getByRole("img", { name: "2 mensagens diretas não lidas" })).toBeVisible();
  await expect(b.page.getByRole("button", { name: "Abrir", exact: true })).toHaveCount(0);

  await a.ctx.close();
  await b.ctx.close();
});

test("push: fluxo de inscrição em Configurações com service worker e PushManager simulados", async ({
  browser,
}) => {
  const b = await person(browser, "b");
  const calls: { method: string; url: string; body: unknown }[] = [];
  await b.ctx.addInitScript(() => {
    // O Playwright não recebe push real: simula só o que a página usa.
    const w = window as unknown as Record<string, unknown>;
    let permission: NotificationPermission = "default";
    let sub: {
      endpoint: string;
      toJSON: () => unknown;
      unsubscribe: () => Promise<boolean>;
    } | null = null;
    const FakeNotification = {
      get permission() {
        return permission;
      },
      requestPermission: async () => {
        permission = "granted";
        return permission;
      },
    };
    w.Notification = FakeNotification;
    w.PushManager = class {};
    const registration = {
      pushManager: {
        getSubscription: async () => sub,
        subscribe: async (o: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }) => {
          (w as { __subscribeOptions?: unknown }).__subscribeOptions = {
            userVisibleOnly: o.userVisibleOnly,
            keyLength: o.applicationServerKey.length,
          };
          sub = {
            endpoint: "https://push.example.test/e2e",
            toJSON: () => ({
              endpoint: "https://push.example.test/e2e",
              keys: { p256dh: "chave-p256dh", auth: "chave-auth" },
            }),
            unsubscribe: async () => {
              sub = null;
              return true;
            },
          };
          return sub;
        },
      },
    };
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        ready: Promise.resolve(registration),
        getRegistration: async () => registration,
        register: async () => registration,
        addEventListener: () => {},
      },
    });
  });
  // O backend do E2E não tem VAPID; as rotas de push são simuladas aqui.
  await b.page.route("**/api/push/**", async (route) => {
    const req = route.request();
    calls.push({
      method: req.method(),
      url: new URL(req.url()).pathname,
      body: req.postDataJSON(),
    });
    if (req.method() === "GET")
      return route.fulfill({
        json: {
          public_key:
            "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U",
        },
      });
    return route.fulfill({ status: 204 });
  });

  await b.page.goto("/settings/notifications");
  await expect(b.page.getByText("Desativadas neste dispositivo.")).toBeVisible();
  // nada de pedir permissão sozinho: só o clique ativa
  expect(await b.page.evaluate(() => Notification.permission)).toBe("default");
  await b.page.getByRole("button", { name: "Ativar notificações" }).click();
  await expect(b.page.getByText("Ativas neste dispositivo.")).toBeVisible();
  expect(
    await b.page.evaluate(
      () => (window as never as { __subscribeOptions: unknown }).__subscribeOptions,
    ),
  ).toEqual({
    userVisibleOnly: true,
    keyLength: 65,
  });
  const post = calls.find((c) => c.method === "POST");
  expect(post?.url).toBe("/api/push/subscriptions");
  expect(post?.body).toEqual({
    endpoint: "https://push.example.test/e2e",
    keys: { p256dh: "chave-p256dh", auth: "chave-auth" },
  });

  await b.page.getByRole("button", { name: "Desativar notificações" }).click();
  await expect(b.page.getByText("Desativadas neste dispositivo.")).toBeVisible();
  expect(calls.find((c) => c.method === "DELETE")?.body).toEqual({
    endpoint: "https://push.example.test/e2e",
  });
  await b.ctx.close();
});

test("o service worker e o manifest são servidos do public/ sem cache imutável", async ({
  request,
}) => {
  const sw = await request.get("/sw.js");
  expect(sw.status()).toBe(200);
  expect(sw.headers()["content-type"]).toMatch(/javascript/);
  expect(sw.headers()["cache-control"]).toBe("no-cache");
  expect(await sw.text()).toContain("showNotification");

  const manifest = await request.get("/manifest.webmanifest");
  expect(manifest.status()).toBe(200);
  expect(manifest.headers()["content-type"]).toContain("manifest+json");
  const json = (await manifest.json()) as Record<string, string>;
  expect(json).toMatchObject({ id: "/", scope: "/", start_url: "/", display: "standalone" });
});
