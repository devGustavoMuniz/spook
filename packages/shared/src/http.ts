// Mutator do orval: fetch nativo (SPEC 5), cookie de sessão same-origin (web) ou Bearer + URL base absoluta
// (desktop), erro tipado do problem+json.

export type ApiFieldError = { message?: string; location?: string; value?: unknown };

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly detail: string,
    public readonly errors: ApiFieldError[] = [],
    /** Segundos do cabeçalho Retry-After (429), quando presente. */
    public readonly retryAfter?: number,
  ) {
    super(detail);
    this.name = "ApiError";
  }
}

let baseUrl = "";
let headersProvider: (() => Record<string, string>) | null = null;

/**
 * Origem absoluta da API (ex.: `https://spook.dottadigital.com`). Vazio = URLs relativas (a web servida
 * pelo próprio backend, ou o proxy do Vite). O app desktop (Tauri) define isto na inicialização.
 */
export function setApiBaseUrl(url: string | null | undefined) {
  baseUrl = (url ?? "").trim().replace(/\/+$/, "");
}
export const getApiBaseUrl = () => baseUrl;

/** Prefixa caminhos da API com a origem configurada; URLs já absolutas passam intactas. */
export function apiUrl(path: string): string {
  return baseUrl && path.startsWith("/") ? `${baseUrl}${path}` : path;
}

/**
 * Cabeçalhos extras de toda requisição (desktop: `X-Spook-Client` e `Authorization: Bearer`). Quando
 * definido, o `fetch` não envia cookies (`credentials: "omit"`): o desktop não usa sessão por cookie.
 */
export function setRequestHeaders(provider: (() => Record<string, string>) | null) {
  headersProvider = provider;
}

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;

/**
 * `fetch` com a mesma autenticação do mutator (cookie same-origin ou Bearer do desktop) e a URL base. Para
 * respostas que não são JSON (ex.: a prévia da transmissão em image/jpeg); o erro fica por conta de quem chama.
 */
export function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(apiUrl(url), {
    credentials: headersProvider ? "omit" : "same-origin",
    ...init,
    headers: { Accept: "application/json", ...headersProvider?.(), ...init?.headers },
  });
}

export async function http<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(url, init);
  const text = [204, 205].includes(res.status) ? "" : await res.text();
  const data: unknown = text ? safeJson(text) : undefined;

  if (!res.ok) {
    const p = (data ?? {}) as { detail?: string; title?: string; errors?: ApiFieldError[] };
    throw new ApiError(
      res.status,
      p.detail ?? p.title ?? res.statusText,
      p.errors ?? [],
      parseRetryAfter(res.headers.get("Retry-After")),
    );
  }
  return data as T;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Sem retry em 4xx: erro do cliente não melhora tentando de novo. 5xx/rede: até 2 tentativas.
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (isApiError(error) && error.status >= 400 && error.status < 500) return false;
  return failureCount < 2;
}

export default http;
