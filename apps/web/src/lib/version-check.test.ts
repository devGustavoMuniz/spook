import { afterEach, describe, expect, it, vi } from "vitest";
import { type BuildInfo, fetchRemoteBuild, isNewerBuild, parseBuildInfo } from "./version-check";

const build = (over: Partial<BuildInfo> = {}): BuildInfo => ({
  version: "0.0.0",
  commit: "abc1234",
  builtAt: "2026-11-01T10:00:00.000Z",
  ...over,
});

describe("parseBuildInfo", () => {
  it("aceita o formato do version.json e recusa o resto", () => {
    expect(parseBuildInfo(build())).toEqual(build());
    expect(parseBuildInfo(null)).toBeNull();
    expect(parseBuildInfo("<html>")).toBeNull();
    expect(parseBuildInfo({ version: "1", commit: 3, builtAt: "x" })).toBeNull();
    expect(parseBuildInfo({ version: "1", commit: "a" })).toBeNull();
  });
});

describe("isNewerBuild", () => {
  it("o sha decide quando os dois são conhecidos", () => {
    expect(isNewerBuild(build(), build())).toBe(false);
    expect(isNewerBuild(build(), build({ commit: "def5678" }))).toBe(true);
    // rebuild do mesmo commit não incomoda
    expect(isNewerBuild(build(), build({ builtAt: "2026-11-02T10:00:00.000Z" }))).toBe(false);
  });
  it("sem sha conhecido vale a data do build", () => {
    expect(isNewerBuild(build({ commit: "unknown" }), build({ commit: "unknown" }))).toBe(false);
    expect(
      isNewerBuild(
        build({ commit: "unknown" }),
        build({ commit: "unknown", builtAt: "2026-11-02T10:00:00.000Z" }),
      ),
    ).toBe(true);
    expect(isNewerBuild(build({ commit: "dev" }), build())).toBe(false);
  });
});

describe("fetchRemoteBuild", () => {
  afterEach(() => vi.restoreAllMocks());

  it("busca sem cache e devolve o build", async () => {
    const fetcher = vi.fn(async () => Response.json(build({ commit: "zzz9999" })));
    expect(await fetchRemoteBuild(fetcher as unknown as typeof fetch)).toEqual(
      build({ commit: "zzz9999" }),
    );
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/^\/version\.json\?t=\d+$/);
    expect(init.cache).toBe("no-store");
  });

  it("qualquer falha vira null (HTML do SPA, 404, rede)", async () => {
    const html = vi.fn(async () => new Response("<!doctype html>", { status: 200 }));
    expect(await fetchRemoteBuild(html as unknown as typeof fetch)).toBeNull();
    const nf = vi.fn(async () => new Response("", { status: 404 }));
    expect(await fetchRemoteBuild(nf as unknown as typeof fetch)).toBeNull();
    const net = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await fetchRemoteBuild(net as unknown as typeof fetch)).toBeNull();
  });
});
