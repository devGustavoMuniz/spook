import { type CropKind, outputSize, type Rect } from "@/lib/crop";
import { AVATAR_MAX_BYTES } from "@/lib/schemas";

/** Carrega a imagem respeitando a orientação EXIF (o `<img>` do navegador já faz o mesmo). */
async function loadBitmap(file: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return await createImageBitmap(file);
  }
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * Desenha `rect` da imagem em `w x h` com reduções pela metade (a redução de uma vez só serrilha em
 * fotos grandes), devolvendo o canvas final.
 */
function drawScaled(bmp: ImageBitmap, rect: Rect, w: number, h: number): HTMLCanvasElement {
  let src: CanvasImageSource = bmp;
  let sx = rect.x;
  let sy = rect.y;
  let sw = rect.w;
  let sh = rect.h;
  while (sw / 2 >= w && sh / 2 >= h) {
    const step = document.createElement("canvas");
    step.width = Math.max(1, Math.floor(sw / 2));
    step.height = Math.max(1, Math.floor(sh / 2));
    const sctx = step.getContext("2d");
    if (!sctx) break;
    sctx.imageSmoothingQuality = "high";
    sctx.drawImage(src, sx, sy, sw, sh, 0, 0, step.width, step.height);
    src = step;
    sx = 0;
    sy = 0;
    sw = step.width;
    sh = step.height;
  }
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, w, h);
  return out;
}

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/**
 * Recorta uma imagem ESTÁTICA no navegador. Saída: PNG se a origem é PNG (mantém transparência), JPEG
 * (qualidade 0,92) para JPEG e para o resto. Se passar de 5 MB, recodifica em JPEG 0,85. Metadados (EXIF/GPS)
 * não vão para o arquivo novo.
 */
export async function renderCrop(file: File, rect: Rect, kind: CropKind): Promise<File> {
  const bmp = await loadBitmap(file);
  try {
    const { w, h } = outputSize(kind, rect);
    const canvas = drawScaled(bmp, rect, w, h);
    const wantPng = file.type === "image/png" || file.type === "image/webp";
    let blob = await toBlob(canvas, wantPng ? "image/png" : "image/jpeg", 0.92);
    if (!blob || blob.size > AVATAR_MAX_BYTES) {
      // Transparência vira fundo preto no JPEG; para fotos grandes é o preço de caber em 5 MB.
      blob = await toBlob(canvas, "image/jpeg", 0.85);
    }
    if (!blob || !(blob.type in EXT)) throw new Error("could not produce the cropped image");
    const base = file.name.replace(/\.[^.]+$/, "") || "imagem";
    return new File([blob], `${base}.${EXT[blob.type]}`, { type: blob.type });
  } finally {
    bmp.close();
  }
}
