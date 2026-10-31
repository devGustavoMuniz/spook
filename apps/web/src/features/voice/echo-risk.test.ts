import { describe, expect, it } from "vitest";
import { outputLooksLikeHeadphones } from "./echo-risk";

const outs = [
  { id: "a", label: "AirPods Pro do Gustavo" },
  { id: "b", label: "Alto-falantes (Realtek)" },
  { id: "c", label: "Dispositivo sem nome" },
  { id: "d", label: "Headset Gamer USB" },
  { id: "e", label: "LG TV (HDMI)" },
];

describe("outputLooksLikeHeadphones (dica, não certeza)", () => {
  it.each([
    ["a", true],
    ["d", true],
    ["b", false],
    ["e", false],
    ["c", null],
  ])("saída %s", (id, expected) => {
    expect(outputLooksLikeHeadphones(outs, id)).toBe(expected);
  });

  it("saída padrão do sistema ou desconhecida: não dá para saber", () => {
    expect(outputLooksLikeHeadphones(outs, undefined)).toBeNull();
    expect(outputLooksLikeHeadphones(outs, "zzz")).toBeNull();
    expect(outputLooksLikeHeadphones([], "a")).toBeNull();
  });
});
