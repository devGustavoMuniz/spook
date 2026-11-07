// Login do desktop pelo navegador (handoff com código de uso único + PKCE).
//
// Fluxo: o app gera um `code_verifier` (guardado só em memória) e abre `PUBLIC_URL/desktop-login?code_challenge=`
// no navegador do sistema; a pessoa confirma "Entrar no app do computador"; o backend gera um código de 60 s e a
// página abre o deep link `spook://auth?code=...`; o app troca `POST /api/auth/desktop/exchange {code,
// code_verifier}` por um token Bearer. O login por e-mail/senha do desktop continua como está.
//
// Lado Rust: `tauri-plugin-deep-link` (esquema `spook://`, também como instância única) em `src-tauri`. O Rust
// valida a URL (só `spook://auth?code=` com código bem formado), traz a janela à frente e emite o evento
// `spook-auth-code` com o código; este módulo escuta esse evento (nunca a URL crua do plugin) e revalida o formato.
// A capability `browserLogin` liga com `VITE_DESKTOP_BROWSER_LOGIN=true`, definido em `apps/web/.env.desktop`
// (só o build do desktop); fora disso fica desligada (SPEC 5.5, "Adicional: deep link spook:// e login do desktop").
import { t } from "@/i18n";
import { invoke } from "./ipc";
import { isTauri } from "./runtime";

/** Capability do login por navegador: só liga no Tauri com `VITE_DESKTOP_BROWSER_LOGIN=true` (build do desktop). */
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

/** Formato do código do deep link (base64url, 20 a 128 caracteres); a mesma regra do Rust (`deeplink.rs`). */
export const isAuthCode = (code: unknown): code is string =>
  typeof code === "string" && /^[A-Za-z0-9_-]{20,128}$/.test(code);

/** Evento emitido pelo Rust com o código já validado de `spook://auth?code=...`. */
export const AUTH_CODE_EVENT = "spook-auth-code";

export type BrowserLoginPorts = {
  /** Abre uma URL no navegador do sistema. */
  openUrl: (url: string) => Promise<void>;
  /** Escuta o código recebido pelo deep link; devolve a função que para de escutar. */
  onAuthCode: (cb: (code: string) => void) => Promise<() => void>;
  /** Troca o código por um token (POST /api/auth/desktop/exchange). */
  exchange: (code: string, verifier: string) => Promise<{ token?: string; user: unknown }>;
};

/** Portas reais: o plugin opener (já registrado no Rust) e o evento `spook-auth-code` emitido pelo Rust. */
export const tauriPorts = (exchange: BrowserLoginPorts["exchange"]): BrowserLoginPorts => ({
  openUrl: (url) => invoke("plugin:opener|open_url", { url }),
  onAuthCode: async (cb) => {
    const { listen } = await import("@tauri-apps/api/event");
    return listen<string>(AUTH_CODE_EVENT, (e) => cb(e.payload));
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
    unlisten = await ports.onAuthCode((code) => {
      if (isAuthCode(code)) resolveCode(code);
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
