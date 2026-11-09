import { describe, expect, it } from "vitest";
import {
  ASPECT,
  baseWindow,
  clampView,
  coversImage,
  cropRect,
  INITIAL_VIEW,
  integerRect,
  MAX_ZOOM,
  outputSize,
  panBy,
  sniffAnimated,
  zoomTo,
} from "./crop";

describe("cropRect", () => {
  it("zoom 1 em imagem larga usa a altura toda e centraliza", () => {
    const r = cropRect(2000, 1000, 1, INITIAL_VIEW);
    expect(r).toEqual({ x: 500, y: 0, w: 1000, h: 1000 });
  });
  it("zoom 1 em imagem alta usa a largura toda", () => {
    expect(cropRect(1000, 3000, 1, INITIAL_VIEW)).toEqual({ x: 0, y: 1000, w: 1000, h: 1000 });
  });
  it("o zoom mínimo cobre a moldura: a janela nunca passa da imagem", () => {
    const r = cropRect(300, 300, 4, { zoom: 0.1, cx: 0.5, cy: 0.5 });
    expect(r.w).toBe(300);
    expect(r.h).toBe(75);
    expect(r.x).toBe(0);
  });
  it("zoom reduz a janela e respeita o máximo", () => {
    const r = cropRect(1000, 1000, 1, { zoom: 2, cx: 0.5, cy: 0.5 });
    expect(r.w).toBe(500);
    expect(cropRect(1000, 1000, 1, { zoom: 99, cx: 0.5, cy: 0.5 }).w).toBe(1000 / MAX_ZOOM);
  });
  it("o centro é limitado às bordas", () => {
    const r = cropRect(1000, 1000, 1, { zoom: 2, cx: 0, cy: 1 });
    expect(r).toEqual({ x: 0, y: 500, w: 500, h: 500 });
  });
  it("banner 4:1 numa imagem quadrada", () => {
    expect(baseWindow(1000, 1000, ASPECT.banner)).toEqual({ w: 1000, h: 250 });
  });
});

describe("panBy", () => {
  it("arrastar para a direita mostra a parte esquerda da imagem", () => {
    const v = panBy(2000, 1000, 1, INITIAL_VIEW, 0.25, 0);
    expect(cropRect(2000, 1000, 1, v).x).toBe(250);
  });
  it("não passa das bordas", () => {
    const v = panBy(2000, 1000, 1, INITIAL_VIEW, 5, 5);
    const r = cropRect(2000, 1000, 1, v);
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
  });
  it("em um eixo sem folga o arraste não faz nada", () => {
    const v = panBy(2000, 1000, 1, INITIAL_VIEW, 0, 0.5);
    expect(cropRect(2000, 1000, 1, v).y).toBe(0);
  });
});

describe("zoomTo", () => {
  it("mantém o ponto sob o cursor parado", () => {
    const iw = 1000;
    const ih = 1000;
    const start = { zoom: 2, cx: 0.5, cy: 0.5 };
    const before = cropRect(iw, ih, 1, start);
    const px = before.x + 0.25 * before.w;
    const v = zoomTo(iw, ih, 1, start, 4, 0.25, 0.5);
    const after = cropRect(iw, ih, 1, v);
    expect(after.x + 0.25 * after.w).toBeCloseTo(px, 5);
  });
  it("limita ao intervalo e volta a centralizar ao chegar em 1", () => {
    expect(zoomTo(1000, 1000, 1, INITIAL_VIEW, 50).zoom).toBe(MAX_ZOOM);
    const v = zoomTo(2000, 1000, 1, { zoom: 3, cx: 0.9, cy: 0.5 }, 0.2);
    expect(v.zoom).toBe(1);
    expect(clampView(2000, 1000, 1, v)).toEqual(v);
  });
});

describe("saída em pixels", () => {
  it("avatar nunca amplia e é quadrado", () => {
    expect(outputSize("avatar", { x: 0, y: 0, w: 200, h: 200 })).toEqual({ w: 200, h: 200 });
    expect(outputSize("avatar", { x: 0, y: 0, w: 3000, h: 3000 })).toEqual({ w: 512, h: 512 });
  });
  it("banner fica em 4:1 até 1280x320", () => {
    expect(outputSize("banner", { x: 0, y: 0, w: 4000, h: 1000 })).toEqual({ w: 1280, h: 320 });
    expect(outputSize("banner", { x: 0, y: 0, w: 400, h: 100 })).toEqual({ w: 400, h: 100 });
  });
  it("integerRect arredonda e fica dentro da imagem", () => {
    expect(integerRect({ x: 10.6, y: -2, w: 99.7, h: 5000 }, 100, 80)).toEqual({
      x: 11,
      y: 0,
      w: 89,
      h: 80,
    });
    expect(coversImage({ x: 0, y: 0, w: 100, h: 80 }, 100, 80)).toBe(true);
    expect(coversImage({ x: 0, y: 0, w: 50, h: 80 }, 100, 80)).toBe(false);
  });
});

describe("sniffAnimated", () => {
  const webp = (flags: number, chunk = "VP8X") => {
    const b = new Uint8Array(32);
    b.set(
      [..."RIFF"].map((c) => c.charCodeAt(0)),
      0,
    );
    b.set(
      [..."WEBP"].map((c) => c.charCodeAt(0)),
      8,
    );
    b.set(
      [...chunk].map((c) => c.charCodeAt(0)),
      12,
    );
    b[20] = flags;
    return b;
  };
  it("WebP animado tem o bit de animação", () => {
    expect(sniffAnimated("image/webp", webp(0x12))).toBe(true);
    expect(sniffAnimated("image/webp", webp(0x10))).toBe(false);
    expect(sniffAnimated("image/webp", webp(0, "VP8 "))).toBe(false);
  });
  it("APNG tem acTL antes do IDAT", () => {
    const sig = [137, 80, 78, 71, 13, 10, 26, 10];
    const chunk = (name: string) => [
      0,
      0,
      0,
      8,
      ...[...name].map((c) => c.charCodeAt(0)),
      0,
      0,
      0,
      0,
    ];
    expect(
      sniffAnimated(
        "image/png",
        new Uint8Array([...sig, ...chunk("IHDR"), ...chunk("acTL"), ...chunk("IDAT")]),
      ),
    ).toBe(true);
    expect(
      sniffAnimated("image/png", new Uint8Array([...sig, ...chunk("IHDR"), ...chunk("IDAT")])),
    ).toBe(false);
  });
});
