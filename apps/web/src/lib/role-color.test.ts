import { describe, expect, it } from "vitest";
import { contrastRatio, readableRoleColor, textOn } from "./role-color";

describe("readableRoleColor", () => {
  it("mantém a cor quando já passa de AA", () => {
    expect(readableRoleColor("#a48ce0", "dark")).toBe("#a48ce0");
    expect(readableRoleColor("#7a1f1f", "light")).toBe("#7a1f1f");
  });
  it("clareia no escuro e escurece no claro até passar de 4.5:1", () => {
    for (const hex of ["#2d1b69", "#1e90ff", "#ffee00", "#e6e6e6", "#000000", "#ff69b4"]) {
      expect(contrastRatio(readableRoleColor(hex, "dark"), "#100e1a")).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(readableRoleColor(hex, "light"), "#f4f1fa")).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("ignora valores inválidos e escolhe texto por luminância", () => {
    expect(readableRoleColor("roxo", "dark")).toBe("roxo");
    expect(textOn("#ffee00")).toBe("#000000");
    expect(textOn("#2d1b69")).toBe("#ffffff");
  });
});
