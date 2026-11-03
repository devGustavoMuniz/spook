// Login do desktop pelo navegador (handoff com código de uso único + PKCE).
//
// Fluxo: o app gera um `code_verifier` (guardado só em memória) e abre `PUBLIC_URL/desktop-login?code_challenge=`
// no navegador do sistema; a pessoa confirma "Entrar no app do computador"; o backend gera um código de 60 s e a
// página abre o deep link `spook://auth?code=...`; o app troca `POST /api/auth/desktop/exchange {code,
// code_verifier}` por um token Bearer. O login por e-mail/senha do desktop continua como está.
//
// LADO RUST PENDENTE: o plugin de deep link (`tauri-plugin-deep-link`, esquema `spook://`, também como instância
// única no Windows/Linux) ainda não está no `src-tauri`. Por isso o fluxo fica atrás da capability
// `browserLogin`, DESLIGADA por padrão (ver PENDENCIAS-DONO.md e SPEC 5.5, "Adicional: e-mail e login social").
import { t } from "@/i18n";
import { invoke } from "./ipc";
import { isTauri } from "./runtime";

/** Capability do login por navegador: só liga com `VITE_DESKTOP_BROWSER_LOGIN=true` (depois do lado Rust). */
export const browserLoginEnabled = (): boolean =>
  isTauri() && import.meta.env.VITE_DESKTOP_BROWSER_LOGIN === "true";

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export type Pkce = { verifier: string; challenge: string };

/** Gera o par PKCE (verificador de 64 caracteres e o desafio S256 de 43). */
export async function createPkce(): Promise<Pkce> {
  const raw = crypto.getRandomValues(new Uint8Array(48));
  const verifier = b64url(raw);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}

/** Extrai o código de `spook://auth?code=...` (qualquer outra URL é ignorada). */
export function parseDeepLink(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "spook:" || u.hostname !== "auth") return null;
    const code = u.searchParams.get("code");
    return code && /^[A-Za-z0-9_-]{20,128}$/.test(code) ? code : null;
  } catch {
    return null;
  }
}

export type BrowserLoginPorts = {
  /** Abre uma URL no navegador do sistema. */
  openUrl: (url: string) => Promise<void>;
  /** Escuta os deep links recebidos; devolve a função que para de escutar. */
  onDeepLink: (cb: (urls: string[]) => void) => Promise<() => void>;
  /** Troca o código por um token (POST /api/auth/desktop/exchange). */
  exchange: (code: string, verifier: string) => Promise<{ token?: string; user: unknown }>;
};

/** Portas reais: o plugin opener (já registrado no Rust) e o evento do plugin de deep link. */
export const tauriPorts = (exchange: BrowserLoginPorts["exchange"]): BrowserLoginPorts => ({
  openUrl: (url) => invoke("plugin:opener|open_url", { url }),
  onDeepLink: async (cb) => {
    const { listen } = await import("@tauri-apps/api/event");
    return listen<string[] | string>("deep-link://new-url", (e) =>
      cb(Array.isArray(e.payload) ? e.payload : [e.payload]),
    );
  },
  exchange,
});

export const BROWSER_LOGIN_TIMEOUT_MS = 5 * 60_000;

export class BrowserLoginError extends Error {
  constructor(
    public readonly reason: "timeout" | "cancelled" | "exchange",
    message: string,
  ) {
    super(message);
    this.name = "BrowserLoginError";
  }
}

/**
 * Faz o fluxo inteiro: abre o navegador, espera o deep link e troca o código. O verificador PKCE nunca sai da
 * memória deste fechamento. `signal` cancela; passa `timeoutMs` para limitar a espera.
 */
export async function loginViaBrowser(opts: {
  baseUrl: string;
  ports: BrowserLoginPorts;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<{ token?: string; user: unknown }> {
  const { ports, signal } = opts;
  const pkce = await createPkce();
  let unlisten: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    let resolveCode!: (code: string) => void;
    let rejectCode!: (e: Error) => void;
    const result = new Promise<string>((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });
    timer = setTimeout(
      () => rejectCode(new BrowserLoginError("timeout", t("settings.browserLogin.timeout"))),
      opts.timeoutMs ?? BROWSER_LOGIN_TIMEOUT_MS,
    );
    signal?.addEventListener("abort", () =>
      rejectCode(new BrowserLoginError("cancelled", t("settings.browserLogin.cancelled"))),
    );
    // Escuta ANTES de abrir o navegador: o deep link pode chegar imediatamente.
    unlisten = await ports.onDeepLink((urls) => {
      for (const u of urls) {
        const code = parseDeepLink(u);
        if (code) {
          resolveCode(code);
          return;
        }
      }
    });
    const url = `${opts.baseUrl.replace(/\/+$/, "")}/desktop-login?code_challenge=${pkce.challenge}`;
    await ports.openUrl(url);
    const code = await result;
    try {
      return await ports.exchange(code, pkce.verifier);
    } catch {
      throw new BrowserLoginError("exchange", t("settings.browserLogin.exchange"));
    }
  } finally {
    clearTimeout(timer);
    unlisten?.();
  }
}
