import { deflateSync } from "node:zlib";
import { expect, type Page, test } from "@playwright/test";
import { grantCmd, grantNitro } from "./grant-nitro";

// Recorte de avatar, banner e ícone: o diálogo abre ao escolher o arquivo; estáticos saem recortados pelo
// canvas (tamanho exato), GIF é recortado pelo servidor preservando os quadros; Esc cancela sem enviar.

const PASSWORD = "senha-forte-123";
const run = Date.now().toString(36);

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer) {
  let c = 0xffffffff;
  for (const b of buf) c = (CRC[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** PNG RGB w x h com um degradê (o conteúdo não importa, só o tamanho). */
function png(w: number, h: number) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * (w * 3 + 1) + 1 + x * 3;
      raw[i] = (x * 255) / w;
      raw[i + 1] = (y * 255) / h;
      raw[i + 2] = 128;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** GIF animado w x h com 2 quadros (cor 1, cor 2), LZW com CLEAR antes de cada pixel (simples e válido). */
function gif(w: number, h: number) {
  const lzw = (color: number) => {
    const bits: number[] = [];
    const push = (code: number) => {
      for (let i = 0; i < 3; i++) bits.push((code >> i) & 1);
    };
    for (let i = 0; i < w * h; i++) {
      push(4); // CLEAR
      push(color);
    }
    push(4);
    push(5); // EOI
    const bytes: number[] = [];
    for (let i = 0; i < bits.length; i += 8) {
      let v = 0;
      for (let j = 0; j < 8; j++) v |= (bits[i + j] ?? 0) << j;
      bytes.push(v);
    }
    const out: number[] = [];
    for (let i = 0; i < bytes.length; i += 255) {
      const part = bytes.slice(i, i + 255);
      out.push(part.length, ...part);
    }
    return Buffer.from([2, ...out, 0]);
  };
  const frame = (color: number) =>
    Buffer.concat([
      Buffer.from([0x21, 0xf9, 4, 0x04, 10, 0, 0, 0]), // atraso 10 cs, disposal 1
      Buffer.from([0x2c, 0, 0, 0, 0, w & 255, w >> 8, h & 255, h >> 8, 0]),
      lzw(color),
    ]);
  return Buffer.concat([
    Buffer.from("GIF89a"),
    Buffer.from([w & 255, w >> 8, h & 255, h >> 8, 0x81, 0, 0]), // paleta global de 4 cores
    Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]),
    Buffer.from([0x21, 0xff, 11, ...Buffer.from("NETSCAPE2.0"), 3, 1, 0, 0, 0]), // laço infinito
    frame(0),
    frame(1),
    Buffer.from([0x3b]),
  ]);
}

async function setup(
  page: Page,
  browserCtx: import("@playwright/test").BrowserContext,
  tag: string,
  nitro = false,
) {
  const username = `e2e_crop_${tag}_${run}`.slice(0, 32);
  const reg = await browserCtx.request.post("/api/auth/register", {
    data: { email: `e2e-crop-${tag}-${run}@spook.dev`, username, password: PASSWORD },
  });
  expect(reg.status()).toBe(201);
  // GIF animado em avatar exige Nitro: concede direto no banco antes de abrir as configurações.
  if (nitro) grantNitro(username);
  await page.goto("/settings/profile");
  const modal = page.getByRole("dialog", { name: "Configurações" });
  await expect(modal.getByRole("heading", { level: 1, name: "Perfil" })).toBeVisible();
  return modal;
}

async function me(page: Page) {
  return (await (await page.request.get("/api/users/me")).json()) as {
    avatar_url?: string;
    banner_url?: string;
  };
}

/** Largura e altura reais da imagem servida (decodificada pelo navegador). */
async function size(page: Page, url: string) {
  return page.evaluate(
    (u) =>
      new Promise<{ w: number; h: number }>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => reject(new Error("imagem não carregou"));
        img.src = u;
      }),
    url,
  );
}

test("avatar estático: recorta no canvas, sem ampliar, e o dialog trava o foco", async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const modal = await setup(page, ctx, "av");

  await modal
    .locator("#avatar-file")
    .setInputFiles({ name: "foto.png", mimeType: "image/png", buffer: png(600, 300) });
  const crop = page.getByRole("dialog", { name: "Ajustar avatar" });
  await expect(crop).toBeVisible();
  await expect(crop.getByTestId("crop-image")).toBeVisible();
  // O foco fica dentro do diálogo e Tab não escapa dele.
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Tab");
    expect(await crop.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  }

  // Moldura quadrada; mover e dar zoom pelo teclado muda o retângulo (e a prévia acompanha).
  const frame = crop.getByTestId("crop-frame");
  const fb = await frame.boundingBox();
  expect(Math.abs((fb?.width ?? 0) - (fb?.height ?? 1))).toBeLessThan(2);
  await frame.focus();
  const before = await crop.getByTestId("crop-image").getAttribute("style");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("+");
  expect(await crop.getByTestId("crop-image").getAttribute("style")).not.toBe(before);
  await page.keyboard.press("-");
  await page.keyboard.press("-");

  await crop.getByRole("button", { name: "Aplicar" }).click();
  await expect(crop).toBeHidden();
  await expect(page.getByText("Avatar atualizado.")).toBeVisible();
  const { avatar_url } = await me(page);
  expect(avatar_url).toBeTruthy();
  // 600x300 em moldura 1:1 com zoom 1 = recorte de 300x300, sem ampliar para 512.
  expect(await size(page, avatar_url as string)).toEqual({ w: 300, h: 300 });
  await ctx.close();
});

test("avatar: Esc cancela sem enviar nada; arquivo grande demais é recusado antes do diálogo", async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const modal = await setup(page, ctx, "esc");
  await modal
    .locator("#avatar-file")
    .setInputFiles({ name: "foto.png", mimeType: "image/png", buffer: png(200, 200) });
  const crop = page.getByRole("dialog", { name: "Ajustar avatar" });
  await expect(crop).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(crop).toBeHidden();
  // O modal de configurações continua aberto (Esc fechou só o recorte).
  await expect(modal).toBeVisible();
  expect((await me(page)).avatar_url).toBeUndefined();

  await modal.locator("#avatar-file").setInputFiles({
    name: "enorme.png",
    mimeType: "image/png",
    buffer: Buffer.alloc(5 * 1024 * 1024 + 1),
  });
  await expect(crop).toBeHidden();
  await expect(modal.getByRole("alert")).toBeVisible();
  await ctx.close();
});

test("banner: moldura 4:1 e saída 4:1", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const modal = await setup(page, ctx, "bn");
  await modal
    .getByLabel("Enviar imagem de banner")
    .setInputFiles({ name: "capa.png", mimeType: "image/png", buffer: png(1000, 500) });
  const crop = page.getByRole("dialog", { name: "Ajustar banner" });
  await expect(crop.getByTestId("crop-image")).toBeVisible();
  const fb = await crop.getByTestId("crop-frame").boundingBox();
  expect((fb?.width ?? 0) / (fb?.height ?? 1)).toBeCloseTo(4, 1);
  await crop.getByRole("button", { name: "Aplicar" }).click();
  await expect(page.getByText("Banner atualizado.")).toBeVisible();
  const { banner_url } = await me(page);
  expect(await size(page, banner_url as string)).toEqual({ w: 1000, h: 250 });
  await ctx.close();
});

test("GIF animado: o servidor recorta todos os quadros e a animação continua", async ({
  browser,
}) => {
  test.skip(
    !grantCmd,
    "defina E2E_GRANT_CMD para conceder Nitro à conta (veja apps/web/README.md)",
  );
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const modal = await setup(page, ctx, "gif", true);
  await modal
    .locator("#avatar-file")
    .setInputFiles({ name: "anim.gif", mimeType: "image/gif", buffer: gif(60, 30) });
  const crop = page.getByRole("dialog", { name: "Ajustar avatar" });
  await expect(crop.getByText(/GIF animado/)).toBeVisible();
  await expect(crop.getByTestId("crop-image")).toBeVisible();
  await crop.getByRole("button", { name: "Aplicar" }).click();
  await expect(page.getByText("Avatar atualizado.")).toBeVisible();
  const { avatar_url } = await me(page);
  const body = await (await ctx.request.get(avatar_url as string)).body();
  expect(body.subarray(0, 6).toString()).toBe("GIF89a");
  expect(body.readUInt16LE(6)).toBe(30); // 60x30 em moldura 1:1 = recorte de 30x30
  expect(body.readUInt16LE(8)).toBe(30);
  let frames = 0;
  for (let i = 0; i + 2 < body.length; i++) {
    if (body[i] === 0x21 && body[i + 1] === 0xf9 && body[i + 2] === 0x04) frames++;
  }
  expect(frames).toBe(2);
  await ctx.close();
});

test("celular: o recorte ocupa a tela inteira", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await ctx.request.post("/api/auth/register", {
    data: {
      email: `e2e-crop-mob-${run}@spook.dev`,
      username: `e2e_crop_mob_${run}`.slice(0, 32),
      password: PASSWORD,
    },
  });
  await page.goto("/settings/profile");
  await page
    .locator("#avatar-file")
    .setInputFiles({ name: "foto.png", mimeType: "image/png", buffer: png(300, 300) });
  const crop = page.getByRole("dialog", { name: "Ajustar avatar" });
  await expect(crop.getByTestId("crop-image")).toBeVisible();
  // A animação de entrada escala o diálogo por instantes: espera assentar.
  await expect
    .poll(async () => {
      const box = await crop.boundingBox();
      return [Math.round(box?.width ?? 0), Math.round(box?.height ?? 0)];
    })
    .toEqual([390, 844]);
  // Os botões continuam à vista.
  await expect(crop.getByRole("button", { name: "Aplicar" })).toBeInViewport();
  await ctx.close();
});
