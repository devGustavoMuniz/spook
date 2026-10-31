// Mutator do orval: fetch nativo (SPEC 5), cookie de sessão same-origin, erro tipado do problem+json.

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

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;

export async function http<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: "same-origin",
    ...init,
    headers: { Accept: "application/json", ...init?.headers },
  });
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
