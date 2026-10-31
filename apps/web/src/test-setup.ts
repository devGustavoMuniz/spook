import "@testing-library/jest-dom/vitest";
import { FakeSocket } from "@spook/shared/testing";
import { toast } from "sonner";
import { afterAll, afterEach, beforeAll } from "vitest";
import { setGatewaySocketFactory } from "@/features/gateway/socket";
import { server } from "@/test/server";

window.scrollTo = () => {};
// jsdom não cria object URLs (miniaturas locais dos anexos).
URL.createObjectURL ??= () => "blob:spook-test";
URL.revokeObjectURL ??= () => {};
// jsdom não tem foco de janela: nos testes o app está sempre "à vista" (os que precisam do contrário trocam o stub).
Document.prototype.hasFocus = () => true;

// O gateway abre um WebSocket ao montar a área autenticada; nos testes ele é falso (nada abre
// sozinho) e os testes de tempo real o comandam por `FakeSocket.last`.
setGatewaySocketFactory((url) => new FakeSocket(url));

// jsdom não faz layout: dá uma janela fixa para o TanStack Virtual e uma altura por item medido.
Object.defineProperties(HTMLElement.prototype, {
  clientHeight: { configurable: true, get: () => 600 },
  clientWidth: { configurable: true, get: () => 800 },
  offsetHeight: {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute("data-index") ? 40 : 0;
    },
  },
});
// scrollTop/scrollTo que funcionam (o jsdom ignora), para testar âncora no fim e preservação de posição.
const scrollTops = new WeakMap<Element, number>();
Object.defineProperty(Element.prototype, "scrollTop", {
  configurable: true,
  get(this: Element) {
    return scrollTops.get(this) ?? 0;
  },
  set(this: Element, v: number) {
    // como o navegador: limitado ao conteúdo
    const max =
      this.scrollHeight > 0 ? this.scrollHeight - this.clientHeight : Number.POSITIVE_INFINITY;
    scrollTops.set(this, Math.min(Math.max(0, v), Math.max(0, max)));
  },
});
// A altura do conteúdo rolável é a do primeiro filho (a lista virtual fixa `height` em style).
Object.defineProperty(Element.prototype, "scrollHeight", {
  configurable: true,
  get(this: Element) {
    const h = Number.parseFloat(
      (this.firstElementChild as HTMLElement | null)?.style?.height ?? "",
    );
    return Number.isFinite(h) ? h : 0;
  },
});
Element.prototype.scrollTo = function (this: Element, arg?: ScrollToOptions | number) {
  this.scrollTop = typeof arg === "number" ? arg : (arg?.top ?? 0);
  this.dispatchEvent(new Event("scroll"));
} as Element["scrollTo"];
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
// Radix (Select) usa estes métodos de ponteiro, ausentes no jsdom.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

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
  toast.dismiss(); // o estado dos toasts é global ao módulo: não vaza para o teste seguinte
  FakeSocket.reset();
  server.resetHandlers();
  document.documentElement.classList.remove("dark");
});
afterAll(() => server.close());
