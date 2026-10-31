import { describe, expect, it } from "vitest";
import { formatBytes } from "./file-size";

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [512, "512 B"],
    [1024, "1 KB"],
    [1536, "1,5 KB"],
    [120 * 1024, "120 KB"],
    [1.5 * 1024 * 1024, "1,5 MB"],
    [25 * 1024 * 1024, "25 MB"],
    [25 * 1024 * 1024 + 1, "25 MB"],
    [3 * 1024 ** 3, "3 GB"],
  ])("%d bytes -> %s", (n, text) => {
    expect(formatBytes(n)).toBe(text);
  });

  it("valor inválido vira travessão", () => {
    expect(formatBytes(-1)).toBe("—");
    expect(formatBytes(Number.NaN)).toBe("—");
  });
});
