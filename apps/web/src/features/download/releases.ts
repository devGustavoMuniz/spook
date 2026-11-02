// Último release do Spook desktop, lido da API pública do GitHub (sem login; CORS liberado). Os instaladores seguem o
// nome `Spook-<versão>-<so>-<arquitetura>.<ext>` gerado pelo workflow Desktop; o resto dos assets (.sig, .sha256,
// latest.json, bundles do updater) é ignorado aqui.
import type { Arch, Os } from "./platform";

export const REPO = "devGustavoMuniz/spook";
export const LATEST_RELEASE_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
export const RELEASES_PAGE_URL = `https://github.com/${REPO}/releases`;

export type InstallerKind = "exe" | "dmg" | "deb" | "AppImage";

export type Installer = {
  name: string;
  os: Os;
  arch: Arch;
  kind: InstallerKind;
  url: string;
  size: number;
  /** SHA-256 em hexadecimal quando a API informa (campo `digest`). */
  sha256: string | null;
  /** Link do arquivo `.sha256` do release, quando existe. */
  checksumUrl: string | null;
};

export type Release = {
  /** Versão do app (sem o prefixo `desktop-v`). */
  version: string;
  publishedAt: string | null;
  pageUrl: string;
  installers: Installer[];
};

const NAME = /^Spook-.+-(windows|macos|linux)-(x64|arm64)\.(exe|dmg|deb|AppImage)$/;

type RawAsset = {
  name?: unknown;
  size?: unknown;
  browser_download_url?: unknown;
  digest?: unknown;
};

/** Converte a resposta crua da API em `Release`; devolve `null` se não houver nenhum instalador reconhecível. */
export function parseRelease(raw: unknown): Release | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const assets = Array.isArray(r.assets) ? (r.assets as RawAsset[]) : [];
  const urlOf = (name: string) => {
    const a = assets.find((x) => x.name === name);
    return a && typeof a.browser_download_url === "string" ? a.browser_download_url : null;
  };
  const installers: Installer[] = [];
  for (const a of assets) {
    if (typeof a.name !== "string" || typeof a.browser_download_url !== "string") continue;
    const m = NAME.exec(a.name);
    if (!m) continue;
    const digest = typeof a.digest === "string" ? /^sha256:([0-9a-f]{64})$/i.exec(a.digest) : null;
    installers.push({
      name: a.name,
      os: m[1] as Os,
      arch: m[2] as Arch,
      kind: m[3] as InstallerKind,
      url: a.browser_download_url,
      size: typeof a.size === "number" ? a.size : 0,
      sha256: digest ? (digest[1] as string).toLowerCase() : null,
      checksumUrl: urlOf(`${a.name}.sha256`),
    });
  }
  if (installers.length === 0) return null;
  const tag = typeof r.tag_name === "string" ? r.tag_name : "";
  return {
    version: tag.replace(/^desktop-v/, "").replace(/^v/, "") || "?",
    publishedAt: typeof r.published_at === "string" ? r.published_at : null,
    pageUrl: typeof r.html_url === "string" ? r.html_url : RELEASES_PAGE_URL,
    installers,
  };
}

export type ReleaseFailure = "rate-limit" | "network" | "error";

export class ReleaseError extends Error {
  constructor(readonly reason: ReleaseFailure) {
    super(reason);
  }
}

/** `null` = ainda não há versão publicada (404, ou release sem instaladores do app). */
export async function fetchLatestRelease(
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<Release | null> {
  let res: Response;
  try {
    res = await fetcher(LATEST_RELEASE_URL, {
      headers: { Accept: "application/vnd.github+json" },
      signal,
    });
  } catch {
    throw new ReleaseError("network");
  }
  if (res.status === 404) return null;
  if (
    res.status === 429 ||
    (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0")
  )
    throw new ReleaseError("rate-limit");
  if (!res.ok) throw new ReleaseError("error");
  try {
    return parseRelease(await res.json());
  } catch {
    throw new ReleaseError("error");
  }
}

// ---- Cache (memória + sessionStorage, tudo com try/catch) ----

const CACHE_KEY = "spook:latest-release";
export const CACHE_TTL_MS = 10 * 60 * 1000;
let memory: { at: number; release: Release | null } | null = null;

export function readCachedRelease(now = Date.now()): { release: Release | null } | null {
  if (memory && now - memory.at < CACHE_TTL_MS) return { release: memory.release };
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { at?: number; release?: Release | null };
    if (typeof parsed.at !== "number" || now - parsed.at >= CACHE_TTL_MS) return null;
    memory = { at: parsed.at, release: parsed.release ?? null };
    return { release: memory.release };
  } catch {
    return null;
  }
}

export function writeCachedRelease(release: Release | null, now = Date.now()) {
  memory = { at: now, release };
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: now, release }));
  } catch {
    // modo privado ou armazenamento cheio: fica só a memória
  }
}

export function clearReleaseCache() {
  memory = null;
  try {
    sessionStorage.removeItem(CACHE_KEY);
  } catch {
    // ignora
  }
}

/** Busca com cache de 10 min (a API anônima do GitHub tem limite de 60 requisições/hora por IP). */
export async function loadLatestRelease(fetcher: typeof fetch = fetch): Promise<Release | null> {
  const cached = readCachedRelease();
  if (cached) return cached.release;
  const release = await fetchLatestRelease(fetcher);
  writeCachedRelease(release);
  return release;
}

// ---- Escolha do instalador ----

export const OS_LABEL: Record<Os, string> = { windows: "Windows", macos: "macOS", linux: "Linux" };
export const KIND_LABEL: Record<InstallerKind, string> = {
  exe: "Instalador (.exe)",
  dmg: "Imagem de disco (.dmg)",
  deb: "Pacote Debian/Ubuntu (.deb)",
  AppImage: "AppImage (qualquer distro)",
};

export type Target = { id: string; os: Os; arch: Arch; title: string; subtitle: string };

/** Os quatro destinos que o workflow Desktop gera, na ordem de exibição. */
export const TARGETS: readonly Target[] = [
  {
    id: "windows-x64",
    os: "windows",
    arch: "x64",
    title: "Windows",
    subtitle: "Windows 10 ou mais novo, 64 bits",
  },
  {
    id: "macos-arm64",
    os: "macos",
    arch: "arm64",
    title: "macOS (Apple Silicon)",
    subtitle: "Macs com chip M1 ou mais novo, macOS 12.3+",
  },
  {
    id: "macos-x64",
    os: "macos",
    arch: "x64",
    title: "macOS (Intel)",
    subtitle: "Macs com processador Intel, macOS 12.3+",
  },
  {
    id: "linux-x64",
    os: "linux",
    arch: "x64",
    title: "Linux",
    subtitle: "Ubuntu 24.04+, Debian 13+, Fedora 40+ (glibc 2.39+)",
  },
];

export const installersFor = (release: Release, t: Pick<Target, "os" | "arch">) =>
  release.installers.filter((i) => i.os === t.os && i.arch === t.arch);

/** Instalador principal de um destino. No Linux o AppImage vem antes do .deb: só ele se atualiza sozinho. */
export function primaryInstaller(list: Installer[]): Installer | null {
  const order: InstallerKind[] = ["exe", "dmg", "AppImage", "deb"];
  return [...list].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))[0] ?? null;
}

/** Destino recomendado: no Mac o palpite da arquitetura (se houver), senão Apple Silicon (maioria dos Macs atuais). */
export function recommendedTarget(os: Os | null, arch: Arch | null): Target | null {
  if (!os) return null;
  if (os === "macos")
    return TARGETS.find((t) => t.id === (arch === "x64" ? "macos-x64" : "macos-arm64")) ?? null;
  return TARGETS.find((t) => t.os === os) ?? null;
}
