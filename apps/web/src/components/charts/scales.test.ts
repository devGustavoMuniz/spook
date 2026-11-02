import { describe, expect, it } from "vitest";
import {
  arcPath,
  areaPath,
  gaugeLevel,
  heatLevel,
  linear,
  linePath,
  nearestIndex,
  niceMax,
  polar,
  ticks,
} from "./scales";

describe("escalas", () => {
  it("niceMax arredonda para 1, 2, 2.5, 5 ou 10 vezes a potência de 10", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(3)).toBe(5);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(130)).toBe(200);
    expect(niceMax(0.3)).toBe(0.5);
    expect(niceMax(Number.NaN)).toBe(1);
  });

  it("ticks vão de 0 ao máximo", () => {
    expect(ticks(10, 2)).toEqual([0, 5, 10]);
  });

  it("linear mapeia o domínio e trata domínio degenerado", () => {
    const f = linear(0, 10, 100, 200);
    expect(f(0)).toBe(100);
    expect(f(5)).toBe(150);
    expect(linear(3, 3, 0, 10)(3)).toBe(5);
  });

  it("linePath quebra a linha em lacunas e areaPath fecha na base", () => {
    expect(linePath([{ x: 0, y: 1 }, { x: 1, y: 2 }, null, { x: 3, y: 4 }])).toBe("M0 1L1 2M3 4");
    expect(
      areaPath(
        [
          { x: 0, y: 1 },
          { x: 10, y: 2 },
        ],
        20,
      ),
    ).toBe("M0 1L10 2L10 20L0 20Z");
    expect(areaPath([], 20)).toBe("");
  });

  it("nearestIndex limita ao intervalo", () => {
    expect(nearestIndex(-10, 100, 5)).toBe(0);
    expect(nearestIndex(60, 100, 5)).toBe(2);
    expect(nearestIndex(500, 100, 5)).toBe(4);
    expect(nearestIndex(10, 100, 1)).toBe(0);
  });

  it("polar e arco: 0 graus à esquerda, 180 à direita", () => {
    const a = polar(50, 50, 40, 0);
    const b = polar(50, 50, 40, 180);
    const m = polar(50, 50, 40, 90);
    expect(a.x).toBeCloseTo(10);
    expect(b.x).toBeCloseTo(90);
    expect(m.y).toBeCloseTo(10);
    expect(arcPath(50, 50, 40, 0, 180)).toMatch(/^M10 50A40 40 0 0 1 90 50$/);
  });

  it("gaugeLevel respeita o sentido da escala", () => {
    expect(gaugeLevel(0.5, 1, 3)).toBe("good");
    expect(gaugeLevel(1, 1, 3)).toBe("warn");
    expect(gaugeLevel(3, 1, 3)).toBe("bad");
    // quanto maior, melhor (nota): ruim até 2, atenção até 4
    expect(gaugeLevel(1.5, 4, 2, false)).toBe("bad");
    expect(gaugeLevel(3, 4, 2, false)).toBe("warn");
    expect(gaugeLevel(4.8, 4, 2, false)).toBe("good");
  });

  it("heatLevel: zero fica neutro e o máximo satura", () => {
    expect(heatLevel(0, 10)).toBe(0);
    expect(heatLevel(10, 10)).toBe(1);
    expect(heatLevel(5, 10)).toBeGreaterThan(0.18);
    expect(heatLevel(1, 0)).toBe(0);
  });
});
