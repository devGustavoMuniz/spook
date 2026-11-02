import { describe, expect, it } from "vitest";
import { detectArch, detectPlatform } from "./platform";

describe("detectPlatform", () => {
  it("usa userAgentData quando existe", () => {
    expect(detectPlatform({ userAgentData: { platform: "Windows", mobile: false } })).toEqual({
      os: "windows",
      mobile: false,
    });
    expect(detectPlatform({ userAgentData: { platform: "macOS" } }).os).toBe("macos");
    expect(detectPlatform({ userAgentData: { platform: "Linux" } }).os).toBe("linux");
  });
  it("cai para platform e userAgent", () => {
    expect(
      detectPlatform({ platform: "Win32", userAgent: "Mozilla/5.0 (Windows NT 10.0)" }).os,
    ).toBe("windows");
    expect(detectPlatform({ platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh)" }).os).toBe(
      "macos",
    );
    expect(detectPlatform({ platform: "Linux x86_64", userAgent: "X11; Linux" }).os).toBe("linux");
    expect(detectPlatform({ userAgent: "Mozilla/5.0 (X11; CrOS x86_64)" }).os).toBe("linux");
  });
  it("celular e desconhecido não têm instalador", () => {
    expect(
      detectPlatform({
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
        platform: "iPhone",
      }),
    ).toEqual({ os: null, mobile: true });
    expect(
      detectPlatform({ userAgent: "Mozilla/5.0 (Linux; Android 14)", platform: "Linux armv8l" })
        .mobile,
    ).toBe(true);
    expect(detectPlatform({ userAgentData: { platform: "Android", mobile: true } }).os).toBeNull();
    expect(detectPlatform({ userAgent: "algo", platform: "?" })).toEqual({
      os: null,
      mobile: false,
    });
    expect(detectPlatform(undefined)).toEqual({ os: null, mobile: false });
  });
});

describe("detectArch", () => {
  const nav = (architecture?: string) => ({
    userAgentData: { getHighEntropyValues: async () => ({ architecture }) },
  });
  it("lê a arquitetura do Chromium", async () => {
    expect(await detectArch(nav("arm"))).toBe("arm64");
    expect(await detectArch(nav("x86"))).toBe("x64");
    expect(await detectArch(nav())).toBeNull();
  });
  it("sem suporte ou com erro devolve null", async () => {
    expect(await detectArch({})).toBeNull();
    expect(await detectArch(undefined)).toBeNull();
    expect(
      await detectArch({
        userAgentData: {
          getHighEntropyValues: async () => {
            throw new Error("negado");
          },
        },
      }),
    ).toBeNull();
  });
});
