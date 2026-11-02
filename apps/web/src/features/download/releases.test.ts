import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CACHE_TTL_MS,
  clearReleaseCache,
  fetchLatestRelease,
  installersFor,
  loadLatestRelease,
  parseRelease,
  primaryInstaller,
  ReleaseError,
  readCachedRelease,
  recommendedTarget,
  TARGETS,
  writeCachedRelease,
} from "./releases";
import { githubRelease } from "./test-fixtures";

describe("parseRelease", () => {
  it("extrai versão, data e os instaladores reconhecidos (ignora .sig, .sha256, latest.json)", () => {
    const r = parseRelease(githubRelease());
    expect(r?.version).toBe("0.2.0");
    expect(r?.publishedAt).toBe("2026-11-02T12:00:00Z");
    expect(r?.installers.map((i) => i.name)).toEqual([
      "Spook-0.2.0-windows-x64.exe",
      "Spook-0.2.0-macos-arm64.dmg",
      "Spook-0.2.0-macos-x64.dmg",
      "Spook-0.2.0-linux-x64.deb",
      "Spook-0.2.0-linux-x64.AppImage",
    ]);
    const win = r?.installers[0];
    expect(win).toMatchObject({ os: "windows", arch: "x64", kind: "exe", size: 90_000_000 });
    expect(win?.sha256).toBe("a".repeat(64));
    expect(win?.checksumUrl).toMatch(/windows-x64\.exe\.sha256$/);
  });

  it("sem digest guarda só o link do .sha256", () => {
    const raw = githubRelease();
    for (const a of raw.assets) delete (a as { digest?: string }).digest;
    const r = parseRelease(raw);
    expect(r?.installers[0]?.sha256).toBeNull();
    expect(r?.installers[0]?.checksumUrl).toBeTruthy();
  });

  it("release sem instaladores do app, ou lixo, vira null", () => {
    expect(
      parseRelease({ tag_name: "x", assets: [{ name: "notes.txt", browser_download_url: "u" }] }),
    ).toBeNull();
    expect(parseRelease({ assets: "nada" })).toBeNull();
    expect(parseRelease(null)).toBeNull();
    expect(parseRelease("x")).toBeNull();
  });
});

describe("escolha do instalador", () => {
  const release = parseRelease(githubRelease());
  it("agrupa por destino e prefere AppImage ao .deb", () => {
    if (!release) throw new Error("sem release");
    const linux = TARGETS.find((t) => t.id === "linux-x64");
    if (!linux) throw new Error("sem destino");
    expect(installersFor(release, linux)).toHaveLength(2);
    expect(primaryInstaller(installersFor(release, linux))?.kind).toBe("AppImage");
    expect(primaryInstaller([])).toBeNull();
  });
  it("recomenda por sistema; no Mac, Apple Silicon salvo palpite de Intel", () => {
    expect(recommendedTarget("windows", null)?.id).toBe("windows-x64");
    expect(recommendedTarget("macos", null)?.id).toBe("macos-arm64");
    expect(recommendedTarget("macos", "x64")?.id).toBe("macos-x64");
    expect(recommendedTarget("linux", null)?.id).toBe("linux-x64");
    expect(recommendedTarget(null, null)).toBeNull();
  });
});

function res(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
}

describe("fetchLatestRelease", () => {
  const fetcher = (r: Response | Error) =>
    vi.fn(async () => {
      if (r instanceof Error) throw r;
      return r;
    }) as unknown as typeof fetch;

  it("200 devolve o release", async () => {
    expect((await fetchLatestRelease(fetcher(res(200, githubRelease()))))?.version).toBe("0.2.0");
  });
  it("404 = ainda não há versão publicada", async () => {
    expect(await fetchLatestRelease(fetcher(res(404, { message: "Not Found" })))).toBeNull();
  });
  it("limite de requisições (429 ou 403 sem restante)", async () => {
    await expect(fetchLatestRelease(fetcher(res(429, {})))).rejects.toMatchObject({
      reason: "rate-limit",
    });
    await expect(
      fetchLatestRelease(fetcher(res(403, {}, { "x-ratelimit-remaining": "0" }))),
    ).rejects.toMatchObject({ reason: "rate-limit" });
  });
  it("outros erros e rede", async () => {
    await expect(fetchLatestRelease(fetcher(res(500, {})))).rejects.toMatchObject({
      reason: "error",
    });
    await expect(fetchLatestRelease(fetcher(res(200, "<html>")))).rejects.toBeInstanceOf(
      ReleaseError,
    );
    await expect(
      fetchLatestRelease(fetcher(new TypeError("Failed to fetch"))),
    ).rejects.toMatchObject({
      reason: "network",
    });
  });
});

describe("cache", () => {
  beforeEach(() => clearReleaseCache());
  afterEach(() => vi.restoreAllMocks());

  it("guarda por 10 min em memória e no sessionStorage", async () => {
    const f = vi.fn(async () => res(200, githubRelease())) as unknown as typeof fetch;
    await loadLatestRelease(f);
    await loadLatestRelease(f);
    expect(f).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem("spook:latest-release")).toContain("0.2.0");
    expect(readCachedRelease(Date.now() + CACHE_TTL_MS + 1)).toBeNull();
  });

  it("guarda também o 'sem versão' (não insiste na API)", async () => {
    const f = vi.fn(async () => res(404, {})) as unknown as typeof fetch;
    expect(await loadLatestRelease(f)).toBeNull();
    expect(await loadLatestRelease(f)).toBeNull();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("sessionStorage quebrado não derruba nada", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("cheio");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("negado");
    });
    writeCachedRelease(null);
    expect(readCachedRelease()).toEqual({ release: null });
    clearReleaseCache();
    expect(readCachedRelease()).toBeNull();
  });

  it("JSON ruim no sessionStorage é ignorado", () => {
    sessionStorage.setItem("spook:latest-release", "{não é json");
    expect(readCachedRelease()).toBeNull();
  });
});
