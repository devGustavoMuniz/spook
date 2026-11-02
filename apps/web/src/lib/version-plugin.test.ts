import { describe, expect, it } from "vitest";
import { resolveBuildInfo, resolveCommit } from "../../vite-version-plugin";

describe("plugin de versão do build", () => {
  it("SPOOK_COMMIT tem prioridade e vira sha curto", () => {
    expect(resolveCommit({ SPOOK_COMMIT: "0123456789abcdef" })).toBe("0123456");
  });

  it("sem variável usa o git (sha curto) ou 'unknown'", () => {
    expect(resolveCommit({})).toMatch(/^([0-9a-f]{7}|unknown)$/);
  });

  it("monta { version, commit, builtAt } com a versão do package.json", () => {
    const info = resolveBuildInfo(new Date("2026-11-02T12:00:00Z"), { SPOOK_COMMIT: "abcdef123" });
    expect(info).toEqual({
      version: expect.stringMatching(/^\d+\.\d+\.\d+/),
      commit: "abcdef1",
      builtAt: "2026-11-02T12:00:00.000Z",
    });
  });

  it("o bundle de teste recebeu as constantes definidas pelo plugin", () => {
    expect(typeof __APP_COMMIT__).toBe("string");
    expect(__APP_BUILT_AT__).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
