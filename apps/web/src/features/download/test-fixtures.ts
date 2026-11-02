const base = "https://github.com/devGustavoMuniz/spook/releases/download/desktop-v0.2.0";

const asset = (name: string, size: number, hex?: string) => ({
  name,
  size,
  browser_download_url: `${base}/${name}`,
  ...(hex ? { digest: `sha256:${hex}` } : {}),
});

/** Resposta da API do GitHub (`releases/latest`) no formato que o workflow Desktop publica. */
export const githubRelease = () => ({
  tag_name: "desktop-v0.2.0",
  published_at: "2026-11-02T12:00:00Z",
  html_url: "https://github.com/devGustavoMuniz/spook/releases/tag/desktop-v0.2.0",
  assets: [
    asset("Spook-0.2.0-windows-x64.exe", 90_000_000, "a".repeat(64)),
    asset("Spook-0.2.0-windows-x64.exe.sha256", 100),
    asset("Spook-0.2.0-windows-x64.exe.sig", 400),
    asset("Spook-0.2.0-macos-arm64.dmg", 110_000_000, "b".repeat(64)),
    asset("Spook-0.2.0-macos-arm64.dmg.sha256", 100),
    asset("Spook-0.2.0-macos-arm64.app.tar.gz", 100_000_000),
    asset("Spook-0.2.0-macos-x64.dmg", 112_000_000, "c".repeat(64)),
    asset("Spook-0.2.0-linux-x64.deb", 80_000_000, "d".repeat(64)),
    asset("Spook-0.2.0-linux-x64.AppImage", 120_000_000, "e".repeat(64)),
    asset("latest.json", 1500),
  ],
});
