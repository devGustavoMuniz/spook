// Último release do Spook desktop. A fonte principal é o backend (`/api/downloads/latest`, que consulta o GitHub com
// cache e não sofre o limite de 60 req/h por IP nem bloqueadores); se ele cair, o navegador consulta a API pública do
// GitHub direto (sem login; CORS liberado). Os instaladores seguem o nome `Spook-<versão>-<so>-<arquitetura>.<ext>` gerado pelo workflow Desktop; o resto dos assets (.sig, .sha256,
// latest.json, bundles do updater) é ignorado aqui.
import { apiUrl } from "@spook/shared";
import type { MessageKey } from "@/i18n";
import type { Arch, Os } from "./platform";

export const REPO = "devGustavoMuniz/spook";
export const LATEST_RELEASE_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
/** Caminho do backend (mesma origem; no desktop vale a base da API). */
export const BACKEND_LATEST_PATH = "/api/downloads/latest";
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

const INSTALLER_OS: readonly string[] = ["windows", "macos", "linux"];
const INSTALLER_ARCH: readonly string[] = ["x64", "arm64"];
const INSTALLER_KIND: readonly string[] = ["exe", "dmg", "deb", "AppImage"];

/** Converte o JSON do backend (snake_case) em `Release`; `undefined` se o formato não for o esperado. */
export function parseBackendRelease(raw: unknown): Release | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.version !== "string" ||
    typeof r.page_url !== "string" ||
    !Array.isArray(r.installers)
  )
    return undefined;
  const installers: Installer[] = [];
  for (const item of r.installers as Record<string, unknown>[]) {
    if (
      !item ||
      typeof item.name !== "string" ||
      typeof item.url !== "string" ||
      !INSTALLER_OS.includes(item.os as string) ||
      !INSTALLER_ARCH.includes(item.arch as string) ||
      !INSTALLER_KIND.includes(item.kind as string)
    )
      return undefined;
    installers.push({
      name: item.name,
      os: item.os as Os,
      arch: item.arch as Arch,
      kind: item.kind as InstallerKind,
      url: item.url,
      size: typeof item.size === "number" ? item.size : 0,
      sha256: typeof item.sha256 === "string" ? item.sha256 : null,
      checksumUrl: typeof item.checksum_url === "string" ? item.checksum_url : null,
    });
  }
  if (installers.length === 0) return undefined;
  return {
    version: r.version,
    publishedAt: typeof r.published_at === "string" ? r.published_at : null,
    pageUrl: r.page_url,
    installers,
  };
}

/**
 * Backend: `Release` (200), `null` (404 = ainda não há versão publicada) ou `undefined` quando o backend não
 * serve (rede, 5xx, 429, corpo inesperado): quem chama cai para o GitHub.
 */
async function fetchFromBackend(
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<Release | null | undefined> {
  try {
    const res = await fetcher(apiUrl(BACKEND_LATEST_PATH), {
      headers: { Accept: "application/json" },
      credentials: "omit",
      signal,
    });
    if (res.status === 404) return null;
    if (!res.ok) return undefined;
    return parseBackendRelease(await res.json());
  } catch {
    if (signal?.aborted) throw new ReleaseError("network");
    return undefined;
  }
}

async function fetchFromGitHub(
  fetcher: typeof fetch,
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

/** `null` = ainda não há versão publicada (404, ou release sem instaladores do app). Backend primeiro, GitHub de reserva. */
export async function fetchLatestRelease(
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<Release | null> {
  const viaBackend = await fetchFromBackend(fetcher, signal);
  if (viaBackend !== undefined) return viaBackend;
  return fetchFromGitHub(fetcher, signal);
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
/** Chaves do catálogo com o rótulo de cada tipo de instalador (traduza com `t`). */
export const KIND_LABEL_KEY = {
  exe: "shell.download.kind.exe",
  dmg: "shell.download.kind.dmg",
  deb: "shell.download.kind.deb",
  AppImage: "shell.download.kind.AppImage",
} as const satisfies Record<InstallerKind, MessageKey>;

export type Target = {
  id: string;
  os: Os;
  arch: Arch;
  titleKey: MessageKey;
  subtitleKey: MessageKey;
};

/** Os quatro destinos que o workflow Desktop gera, na ordem de exibição. */
export const TARGETS: readonly Target[] = [
  {
    id: "windows-x64",
    os: "windows",
    arch: "x64",
    titleKey: "shell.download.target.windows.title",
    subtitleKey: "shell.download.target.windows.subtitle",
  },
  {
    id: "macos-arm64",
    os: "macos",
    arch: "arm64",
    titleKey: "shell.download.target.macosArm.title",
    subtitleKey: "shell.download.target.macosArm.subtitle",
  },
  {
    id: "macos-x64",
    os: "macos",
    arch: "x64",
    titleKey: "shell.download.target.macosIntel.title",
    subtitleKey: "shell.download.target.macosIntel.subtitle",
  },
  {
    id: "linux-x64",
    os: "linux",
    arch: "x64",
    titleKey: "shell.download.target.linux.title",
    subtitleKey: "shell.download.target.linux.subtitle",
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
