import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

export type BuildInfo = { version: string; commit: string; builtAt: string };

/** Sha curto: `SPOOK_COMMIT` (CI/Docker, onde não há `.git`) ou o git local; `unknown` se nenhum existir. */
export function resolveCommit(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.SPOOK_COMMIT?.trim();
  if (fromEnv) return fromEnv.slice(0, 7);
  try {
    return execSync("git rev-parse --short=7 HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

export function resolveBuildInfo(
  now = new Date(),
  env: NodeJS.ProcessEnv = process.env,
): BuildInfo {
  const pkg = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "package.json"), "utf8"),
  ) as {
    version: string;
  };
  return { version: pkg.version, commit: resolveCommit(env), builtAt: now.toISOString() };
}

/**
 * Embute a identidade do build no bundle (`__APP_VERSION__`, `__APP_COMMIT__`, `__APP_BUILT_AT__`) e publica a mesma
 * em `version.json` na raiz do `dist` (o servidor o serve com `Cache-Control: no-cache`). O app compara as duas para
 * avisar "Nova versão disponível". No modo `desktop` o arquivo não é emitido: o app nativo se atualiza pelo updater.
 */
export function versionPlugin(): Plugin {
  const info = resolveBuildInfo();
  let desktop = false;
  return {
    name: "spook-version",
    config(_, env) {
      desktop = env.mode === "desktop";
      return {
        define: {
          __APP_VERSION__: JSON.stringify(info.version),
          __APP_COMMIT__: JSON.stringify(info.commit),
          __APP_BUILT_AT__: JSON.stringify(info.builtAt),
        },
      };
    },
    generateBundle() {
      if (desktop) return;
      this.emitFile({
        type: "asset",
        fileName: "version.json",
        source: `${JSON.stringify(info, null, 2)}\n`,
      });
    },
  };
}
