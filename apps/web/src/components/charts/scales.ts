/** Geometria e escalas puras dos gráficos (sem React), para testar sem DOM. */

/** Teto "redondo" para o eixo: 1, 2, 2.5, 5 ou 10 vezes uma potência de 10. */
export function niceMax(max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(max));
  const f = max / exp;
  const step = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return step * exp;
}

/** Valores de grade de 0 até `max` (inclusive), `count` intervalos. */
export function ticks(max: number, count = 2): number[] {
  return Array.from({ length: count + 1 }, (_, i) => (max * i) / count);
}

export type Linear = (v: number) => number;

/** Mapeia [d0, d1] em [r0, r1]; domínio degenerado cai no meio do intervalo. */
export function linear(d0: number, d1: number, r0: number, r1: number): Linear {
  if (d1 === d0) return () => (r0 + r1) / 2;
  return (v) => r0 + ((v - d0) / (d1 - d0)) * (r1 - r0);
}

export type Pt = { x: number; y: number };

const r = (n: number) => Math.round(n * 100) / 100;

/** "M x y L x y …"; pontos nulos (lacunas) quebram a linha em segmentos. */
export function linePath(points: (Pt | null)[]): string {
  let d = "";
  let pen = false;
  for (const p of points) {
    if (!p) {
      pen = false;
      continue;
    }
    d += `${pen ? "L" : "M"}${r(p.x)} ${r(p.y)}`;
    pen = true;
  }
  return d;
}

/** Área fechada até a linha de base (só para séries sem lacuna). */
export function areaPath(points: Pt[], baseline: number): string {
  if (points.length === 0) return "";
  const first = points[0] as Pt;
  const last = points[points.length - 1] as Pt;
  return `${linePath(points)}L${r(last.x)} ${r(baseline)}L${r(first.x)} ${r(baseline)}Z`;
}

/** Índice do ponto mais próximo de `x` (pontos igualmente espaçados em [0, width]). */
export function nearestIndex(x: number, width: number, count: number): number {
  if (count <= 1 || width <= 0 || !Number.isFinite(x)) return 0;
  const i = Math.round((x / width) * (count - 1));
  return Math.min(count - 1, Math.max(0, i));
}

/** Coordenada polar → cartesiana; ângulo em graus, 0 = esquerda, 180 = direita (semicírculo por cima). */
export function polar(cx: number, cy: number, radius: number, deg: number): Pt {
  const a = Math.PI - (deg * Math.PI) / 180;
  return { x: cx + radius * Math.cos(a), y: cy - radius * Math.sin(a) };
}

/** Arco de `from` a `to` graus (0 a 180) sobre o semicírculo. */
export function arcPath(cx: number, cy: number, radius: number, from: number, to: number): string {
  const a = polar(cx, cy, radius, from);
  const b = polar(cx, cy, radius, to);
  const large = Math.abs(to - from) > 180 ? 1 : 0;
  return `M${r(a.x)} ${r(a.y)}A${radius} ${radius} 0 ${large} 1 ${r(b.x)} ${r(b.y)}`;
}

export type GaugeLevel = "good" | "warn" | "bad";

/**
 * Faixa do medidor. `warnAt`/`badAt` são limiares: `higherIsWorse` (padrão) → bom abaixo de `warnAt`,
 * médio até `badAt`, ruim a partir dele. Com `higherIsWorse: false` a lógica se inverte.
 */
export function gaugeLevel(
  value: number,
  warnAt: number,
  badAt: number,
  higherIsWorse = true,
): GaugeLevel {
  if (higherIsWorse) return value >= badAt ? "bad" : value >= warnAt ? "warn" : "good";
  return value <= badAt ? "bad" : value <= warnAt ? "warn" : "good";
}

export const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** Intensidade 0..1 de uma célula do heatmap (escala sequencial linear; 0 só quando o valor é 0). */
export function heatLevel(value: number, max: number): number {
  if (!(value > 0) || !(max > 0)) return 0;
  return 0.18 + 0.82 * clamp01(value / max);
}
