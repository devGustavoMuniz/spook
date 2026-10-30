import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, http, isApiError, shouldRetry } from "./http";

afterEach(() => vi.restoreAllMocks());

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

  it("não faz retry em 4xx, mas tenta de novo em 5xx", () => {
    expect(shouldRetry(0, new ApiError(401, "x"))).toBe(false);
    expect(shouldRetry(0, new ApiError(500, "x"))).toBe(true);
    expect(shouldRetry(2, new ApiError(500, "x"))).toBe(false);
    expect(shouldRetry(0, new TypeError("rede"))).toBe(true);
  });
});
