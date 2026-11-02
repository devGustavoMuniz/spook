import { describe, expect, it } from "vitest";
import { bestGrid } from "./layout";

describe("bestGrid", () => {
  it("duas pessoas ficam lado a lado em tela larga; três preferem mais colunas se quase empata", () => {
    expect(bestGrid(900, 700, 2, 12).cols).toBe(2);
    expect(bestGrid(864, 748, 3, 12).cols).toBe(2);
  });

  it("uma pessoa ocupa a área toda respeitando 16:9", () => {
    const g = bestGrid(1200, 600, 1, 12);
    expect(g.cols).toBe(1);
    expect(g.tileWidth).toBe(Math.floor((600 * 16) / 9));
  });

  it("recalcula as colunas conforme entra gente", () => {
    const cols = [1, 2, 3, 4, 6].map((n) => bestGrid(1440, 760, n, 12).cols);
    expect(cols[0]).toBe(1);
    expect(cols[1]).toBe(2);
    expect(cols[3]).toBeGreaterThanOrEqual(2);
    expect(cols[4]).toBeGreaterThanOrEqual(cols[3] as number);
  });

  it("os tiles nunca ultrapassam a largura nem a altura", () => {
    for (let n = 1; n <= 12; n++) {
      const g = bestGrid(1000, 600, n, 12);
      expect(g.cols * g.tileWidth + (g.cols - 1) * 12).toBeLessThanOrEqual(1000);
      if (g.tileWidth >= 220)
        expect(g.rows * (g.tileWidth / (16 / 9)) + (g.rows - 1) * 12).toBeLessThanOrEqual(600);
    }
  });

  it("em tela estreita (390 px) é uma coluna só, com a largura inteira", () => {
    const g = bestGrid(366, 640, 5, 12);
    expect(g).toEqual({ cols: 1, rows: 5, tileWidth: 366 });
  });
});
