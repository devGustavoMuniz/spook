import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  apiUrl,
  http,
  isApiError,
  setApiBaseUrl,
  setRequestHeaders,
  shouldRetry,
} from "./http";

afterEach(() => {
  vi.restoreAllMocks();
  setApiBaseUrl("");
  setRequestHeaders(null);
});

describe("http", () => {
  it("devolve o JSON em sucesso e envia credentials same-origin", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    await expect(http("/x")).resolves.toEqual({ ok: 1 });
    expect(spy.mock.calls[0]?.[1]).toMatchObject({ credentials: "same-origin" });
  });

  it("devolve undefined em 204", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    await expect(http("/x")).resolves.toBeUndefined();
  });

  it("lança ApiError tipado a partir do problem+json", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          title: "Conflict",
          detail: "e-mail já cadastrado",
          errors: [{ message: "m" }],
        }),
        {
          status: 409,
        },
      ),
    );
    const err = await http("/x").catch((e) => e);
    expect(isApiError(err)).toBe(true);
    expect(err).toMatchObject({ status: 409, detail: "e-mail já cadastrado" });
    expect((err as ApiError).errors).toHaveLength(1);
  });

  it("expõe o Retry-After do 429 em segundos", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ detail: "devagar" }), {
        status: 429,
        headers: { "Retry-After": "3" },
      }),
    );
    const err = await http("/x").catch((e) => e);
    expect(err).toMatchObject({ status: 429, retryAfter: 3 });
  });

  it("não faz retry em 4xx, mas tenta de novo em 5xx", () => {
    expect(shouldRetry(0, new ApiError(401, "x"))).toBe(false);
    expect(shouldRetry(0, new ApiError(500, "x"))).toBe(true);
    expect(shouldRetry(2, new ApiError(500, "x"))).toBe(false);
    expect(shouldRetry(0, new TypeError("rede"))).toBe(true);
  });
});

describe("modo desktop", () => {
  it("prefixa a URL base, envia os cabeçalhos extras e não envia cookies", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    setApiBaseUrl("https://api.exemplo.com/");
    setRequestHeaders(() => ({ "X-Spook-Client": "desktop", Authorization: "Bearer t0k" }));
    await http("/api/users/me");
    const [url, init] = spy.mock.calls[0] ?? [];
    expect(url).toBe("https://api.exemplo.com/api/users/me");
    expect(init).toMatchObject({ credentials: "omit" });
    expect(init?.headers).toMatchObject({
      Accept: "application/json",
      Authorization: "Bearer t0k",
    });
  });

  it("deixa URLs absolutas e relativas sem base como estão", () => {
    expect(apiUrl("/api/x")).toBe("/api/x");
    setApiBaseUrl("https://a.example");
    expect(apiUrl("https://b.example/x")).toBe("https://b.example/x");
    expect(apiUrl("/api/x")).toBe("https://a.example/api/x");
  });
});
