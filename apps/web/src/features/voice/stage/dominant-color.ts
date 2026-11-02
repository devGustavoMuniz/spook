import { useEffect, useState } from "react";
import { avatarColor } from "@/components/ui/avatar";

export type TileColor = { from: string; to: string };

const cache = new Map<string, TileColor | null>();

/** Cor derivada do usuário (matiz estável por id): usada sem imagem ou quando a leitura da imagem falha. */
export function derivedColor(seed: string): TileColor {
  const { hue } = avatarColor(seed);
  return { from: `hsl(${hue} 42% 34%)`, to: `hsl(${(hue + 24) % 360} 48% 22%)` };
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}

/**
 * Cor dominante barata: média ponderada pela saturação dos pixels de um canvas 8x8.
 * Luminosidade e saturação são limitadas para o texto branco do tile sempre ter contraste (AA).
 */
export function colorFromPixels(data: ArrayLike<number>): TileColor {
  let r = 0;
  let g = 0;
  let b = 0;
  let w = 0;
  for (let i = 0; i + 3 < data.length; i += 4) {
    if ((data[i + 3] ?? 0) < 128) continue;
    const pr = data[i] ?? 0;
    const pg = data[i + 1] ?? 0;
    const pb = data[i + 2] ?? 0;
    const weight = 0.15 + (Math.max(pr, pg, pb) - Math.min(pr, pg, pb)) / 255;
    r += pr * weight;
    g += pg * weight;
    b += pb * weight;
    w += weight;
  }
  if (w === 0) return { from: "hsl(260 12% 30%)", to: "hsl(260 12% 20%)" };
  const [h, s] = rgbToHsl(r / w, g / w, b / w);
  const sat = Math.round(Math.min(Math.max(s, 0.18), 0.6) * 100);
  return { from: `hsl(${Math.round(h)} ${sat}% 34%)`, to: `hsl(${Math.round(h)} ${sat}% 21%)` };
}

function extract(url: string): Promise<TileColor | null> {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = 8;
          canvas.height = 8;
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          if (!ctx) return resolve(null);
          ctx.drawImage(img, 0, 0, 8, 8);
          resolve(colorFromPixels(ctx.getImageData(0, 0, 8, 8).data)); // lança se o canvas foi "tainted"
        } catch {
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = url;
    } catch {
      resolve(null);
    }
  });
}

/** Cor de fundo do tile: dominante do avatar (cache por URL) ou, na falta, a derivada do usuário. */
export function useTileColor(url: string | undefined, seed: string): TileColor {
  const [fromImage, setFromImage] = useState<TileColor | null>(() =>
    url ? (cache.get(url) ?? null) : null,
  );
  useEffect(() => {
    if (!url) {
      setFromImage(null);
      return;
    }
    if (cache.has(url)) {
      setFromImage(cache.get(url) ?? null);
      return;
    }
    let alive = true;
    void extract(url).then((c) => {
      cache.set(url, c);
      if (alive) setFromImage(c);
    });
    return () => {
      alive = false;
    };
  }, [url]);
  return fromImage ?? derivedColor(seed);
}
