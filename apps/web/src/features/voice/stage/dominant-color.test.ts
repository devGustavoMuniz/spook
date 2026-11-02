import { describe, expect, it } from "vitest";
import { colorFromPixels, derivedColor } from "./dominant-color";

describe("cor do tile", () => {
  it("a cor derivada é estável por usuário", () => {
    expect(derivedColor("42")).toEqual(derivedColor("42"));
    expect(derivedColor("42")).not.toEqual(derivedColor("43"));
  });

  it("a cor dominante vem dos pixels e fica escura o bastante para o texto branco", () => {
    // 64 pixels vermelhos opacos
    const data = new Uint8ClampedArray(8 * 8 * 4);
    for (let i = 0; i < data.length; i += 4) data.set([220, 30, 40, 255], i);
    const c = colorFromPixels(data);
    expect(c.from).toMatch(/^hsl\((35[0-9]|[0-9]|3[0-4][0-9]) \d+% 34%\)$/);
    expect(c.to).toMatch(/21%\)$/);
  });

  it("imagem sem pixels visíveis cai num cinza neutro", () => {
    expect(colorFromPixels(new Uint8ClampedArray(16)).from).toContain("12%");
  });
});
