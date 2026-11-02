// Aviso de "Nova versão disponível" (web). O build publica `/version.json` ({ version, commit, builtAt }) e embute a
// mesma identidade no bundle; quando o arquivo do servidor muda, a aba aberta está desatualizada.

export type BuildInfo = { version: string; commit: string; builtAt: string };

/** Identidade do build que está rodando nesta aba. */
export const currentBuild = (): BuildInfo => ({
  version: __APP_VERSION__,
  commit: __APP_COMMIT__,
  builtAt: __APP_BUILT_AT__,
});

/** Valida o JSON do servidor (nunca confia no formato). */
export function parseBuildInfo(raw: unknown): BuildInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (
    typeof o.version !== "string" ||
    typeof o.commit !== "string" ||
    typeof o.builtAt !== "string"
  )
    return null;
  return { version: o.version, commit: o.commit, builtAt: o.builtAt };
}

const known = (commit: string) => commit !== "" && commit !== "unknown" && commit !== "dev";

/**
 * O servidor tem um build diferente do da aba? Com o sha conhecido nos dois lados, só o sha decide (reconstruir o
 * mesmo commit não incomoda ninguém); sem ele, vale a data do build.
 */
export function isNewerBuild(local: BuildInfo, remote: BuildInfo): boolean {
  if (known(local.commit) && known(remote.commit)) return local.commit !== remote.commit;
  return local.builtAt !== remote.builtAt || local.version !== remote.version;
}

/** Busca o `version.json` ignorando qualquer cache (HTTP e do navegador). `null` em qualquer falha. */
export async function fetchRemoteBuild(
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<BuildInfo | null> {
  try {
    const res = await fetcher(`/version.json?t=${Date.now()}`, { cache: "no-store", signal });
    if (!res.ok) return null;
    // O fallback do SPA devolve HTML para arquivos inexistentes: JSON inválido vira `null`.
    return parseBuildInfo(await res.json());
  } catch {
    return null;
  }
}
