import "@testing-library/jest-dom/vitest";
import { afterAll, afterEach, beforeAll } from "vitest";
import { server } from "@/test/server";

window.scrollTo = () => {};

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  // jsdom não traz fetch e o do Node exige URL absoluta; o front usa caminhos relativos (/api/...).
  // O wrapper vem depois do listen() para o MSW receber a requisição já normalizada.
  const mswFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === "string" && input.startsWith("/"))
      input = new URL(input, window.location.origin).href;
    // O AbortSignal do jsdom não é aceito pelo fetch do Node; cancelamento não importa nos testes.
    return mswFetch(input, init ? { ...init, signal: undefined } : init);
  }) as typeof fetch;
});
afterEach(() => {
  server.resetHandlers();
  document.documentElement.classList.remove("dark");
});
afterAll(() => server.close());
