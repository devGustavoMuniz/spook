import { useTheme } from "@/components/theme-provider";

// Superfícies onde nome de cargo aparece (surface-1 é a pior das duas em cada tema; ver packages/brand/src/tokens.css).
const SURFACE = { light: "#f4f1fa", dark: "#100e1a" } as const;
const TARGET = 4.7; // AA para texto normal é 4.5; sobra margem para hover/realce

function parse(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m?.[1]) return null;
  const n = Number.parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 1;
  const [hi, lo] = [luminance(pa), luminance(pb)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const toHex = (c: [number, number, number]) =>
  `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

/**
 * Cor de texto para um cargo: a própria cor do cargo se já passa de AA sobre a superfície do tema; senão
 * é clareada (escuro) ou escurecida (claro) na direção do preto/branco até passar, mantendo o matiz.
 */
export function readableRoleColor(hex: string, theme: "light" | "dark"): string {
  const rgb = parse(hex);
  if (!rgb) return hex;
  const bg = SURFACE[theme];
  if (contrastRatio(hex, bg) >= TARGET) return hex;
  const target = theme === "dark" ? 255 : 0;
  for (let t = 0.05; t <= 1.0001; t += 0.05) {
    const mixed = toHex(rgb.map((v) => v + (target - v) * t) as [number, number, number]);
    if (contrastRatio(mixed, bg) >= TARGET) return mixed;
  }
  return toHex([target, target, target]);
}

/** Texto (preto ou branco) legível sobre um fundo de cargo, escolhido pela luminância. */
export function textOn(hex: string): "#000000" | "#ffffff" {
  const rgb = parse(hex);
  if (!rgb) return "#ffffff";
  return contrastRatio(hex, "#ffffff") >= contrastRatio(hex, "#000000") ? "#ffffff" : "#000000";
}

/** Cor do cargo já ajustada para o tema atual (undefined se o cargo não tem cor). */
export function useReadableRoleColor(hex: string | undefined): string | undefined {
  const { resolved } = useTheme();
  return hex ? readableRoleColor(hex, resolved) : undefined;
}
