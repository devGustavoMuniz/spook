/**
 * Geometria do recorte de imagem (funções puras, sem DOM).
 *
 * O estado é independente de pixels de tela: `zoom` (1 = a moldura cobre a imagem justa, "cover") e o
 * centro `cx`/`cy` em fração da imagem (0..1). Com isso o mesmo estado vale para a moldura grande, para as
 * pré-visualizações e para a saída em pixels.
 */

export type Rect = { x: number; y: number; w: number; h: number };
export type CropView = { zoom: number; cx: number; cy: number };

export type CropKind = "avatar" | "icon" | "banner";

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 8;

/** Proporção (largura/altura) da moldura por tipo. O banner é exibido a 4:1 (cartão de perfil 320x80). */
export const ASPECT: Record<CropKind, number> = { avatar: 1, icon: 1, banner: 4 };

/** Maior saída (px) por tipo: avatar/ícone 512x512; banner 1280x320 (2x do cartão de 640x160). */
export const MAX_OUTPUT: Record<CropKind, { w: number; h: number }> = {
  avatar: { w: 512, h: 512 },
  icon: { w: 512, h: 512 },
  banner: { w: 1280, h: 320 },
};

export const INITIAL_VIEW: CropView = { zoom: 1, cx: 0.5, cy: 0.5 };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function clampZoom(zoom: number): number {
  return Number.isFinite(zoom) ? clamp(zoom, MIN_ZOOM, MAX_ZOOM) : MIN_ZOOM;
}

/** Maior retângulo com a proporção `aspect` que cabe dentro da imagem (zoom 1). */
export function baseWindow(iw: number, ih: number, aspect: number): { w: number; h: number } {
  if (iw / ih > aspect) return { w: ih * aspect, h: ih };
  return { w: iw, h: iw / aspect };
}

/** Retângulo visível da imagem (em pixels dela) para a vista dada: sempre dentro da imagem. */
export function cropRect(iw: number, ih: number, aspect: number, view: CropView): Rect {
  const base = baseWindow(iw, ih, aspect);
  const zoom = clampZoom(view.zoom);
  const w = base.w / zoom;
  const h = base.h / zoom;
  return {
    x: clamp(view.cx * iw - w / 2, 0, iw - w),
    y: clamp(view.cy * ih - h / 2, 0, ih - h),
    w,
    h,
  };
}

/** Vista normalizada: zoom dentro dos limites e o centro de modo que a moldura nunca saia da imagem. */
export function clampView(iw: number, ih: number, aspect: number, view: CropView): CropView {
  const r = cropRect(iw, ih, aspect, view);
  return { zoom: clampZoom(view.zoom), cx: (r.x + r.w / 2) / iw, cy: (r.y + r.h / 2) / ih };
}

/** Arrasta a imagem: `dx`/`dy` em fração da moldura (positivo = a imagem acompanha o dedo para a direita/baixo). */
export function panBy(
  iw: number,
  ih: number,
  aspect: number,
  view: CropView,
  dx: number,
  dy: number,
): CropView {
  const r = cropRect(iw, ih, aspect, view);
  return clampView(iw, ih, aspect, {
    zoom: view.zoom,
    cx: (r.x + r.w / 2 - dx * r.w) / iw,
    cy: (r.y + r.h / 2 - dy * r.h) / ih,
  });
}

/** Troca o zoom mantendo o ponto `(fx, fy)` da moldura (0..1, padrão o centro) parado. */
export function zoomTo(
  iw: number,
  ih: number,
  aspect: number,
  view: CropView,
  zoom: number,
  fx = 0.5,
  fy = 0.5,
): CropView {
  const before = cropRect(iw, ih, aspect, view);
  const px = before.x + fx * before.w;
  const py = before.y + fy * before.h;
  const next = clampZoom(zoom);
  const base = baseWindow(iw, ih, aspect);
  const w = base.w / next;
  const h = base.h / next;
  return clampView(iw, ih, aspect, {
    zoom: next,
    cx: (px - fx * w + w / 2) / iw,
    cy: (py - fy * h + h / 2) / ih,
  });
}

/** Tamanho de saída: o do recorte, limitado ao máximo do tipo (nunca amplia), na proporção exata. */
export function outputSize(kind: CropKind, rect: Rect): { w: number; h: number } {
  const max = MAX_OUTPUT[kind];
  const scale = Math.min(1, max.w / rect.w, max.h / rect.h);
  const w = Math.max(1, Math.round(rect.w * scale));
  return { w, h: Math.max(1, Math.round(w / ASPECT[kind])) };
}

/** Retângulo em pixels inteiros dentro da imagem (para o recorte de GIF no servidor). */
export function integerRect(rect: Rect, iw: number, ih: number): Rect {
  const x = clamp(Math.round(rect.x), 0, iw - 1);
  const y = clamp(Math.round(rect.y), 0, ih - 1);
  return {
    x,
    y,
    w: clamp(Math.round(rect.w), 1, iw - x),
    h: clamp(Math.round(rect.h), 1, ih - y),
  };
}

/** `true` se o retângulo cobre a imagem inteira (não há o que recortar). */
export function coversImage(rect: Rect, iw: number, ih: number): boolean {
  return rect.w >= iw - 0.5 && rect.h >= ih - 0.5;
}

/**
 * Estilo (em %) de uma `<img>` posicionada de forma absoluta dentro de uma moldura `overflow-hidden` para
 * mostrar só `rect`. Vale para qualquer tamanho de moldura (principal e prévias).
 */
export function imageStyle(rect: Rect, iw: number, ih: number) {
  return {
    position: "absolute" as const,
    maxWidth: "none",
    width: `${(iw / rect.w) * 100}%`,
    height: `${(ih / rect.h) * 100}%`,
    left: `${(-rect.x / rect.w) * 100}%`,
    top: `${(-rect.y / rect.h) * 100}%`,
  };
}

/** Animado? Lê o início do arquivo: WebP (VP8X com o bit de animação) e APNG (`acTL`). GIF é tratado à parte. */
export function sniffAnimated(type: string, head: Uint8Array): boolean {
  const ascii = (from: number, to: number) => String.fromCharCode(...head.slice(from, to));
  if (type === "image/webp") {
    return (
      ascii(0, 4) === "RIFF" &&
      ascii(8, 12) === "WEBP" &&
      ascii(12, 16) === "VP8X" &&
      ((head[20] ?? 0) & 0x02) !== 0
    );
  }
  if (type === "image/png") {
    // `acTL` vem antes do primeiro IDAT; cabe nos primeiros bytes depois do IHDR.
    for (let i = 8; i + 4 <= head.length; i++) {
      if (ascii(i, i + 4) === "acTL") return true;
      if (ascii(i, i + 4) === "IDAT") return false;
    }
  }
  return false;
}
