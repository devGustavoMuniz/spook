import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { beforeEach, describe, expect, it, vi } from "vitest";

// O sw.js é estático (sem bundler): roda aqui num escopo global simulado de service worker.
const source = readFileSync(resolve(__dirname, "../public/sw.js"), "utf8");

type Listener = (event: unknown) => void;

function load() {
  const listeners: Record<string, Listener> = {};
  const shown: { title: string; opts: Record<string, unknown> }[] = [];
  const windows: {
    url: string;
    focus: ReturnType<typeof vi.fn>;
    postMessage: ReturnType<typeof vi.fn>;
  }[] = [];
  const openWindow = vi.fn(async () => undefined);
  const self = {
    location: { origin: "https://spook.test" },
    addEventListener: (type: string, fn: Listener) => {
      listeners[type] = fn;
    },
    skipWaiting: vi.fn(),
    registration: {
      showNotification: vi.fn(async (title: string, opts: Record<string, unknown>) => {
        shown.push({ title, opts });
      }),
    },
    clients: {
      claim: vi.fn(async () => undefined),
      matchAll: vi.fn(async () => windows),
      openWindow,
    },
  };
  vm.runInNewContext(source, { self, URL, console });
  return { listeners, shown, windows, openWindow, self };
}

/** Evento `push` com `waitUntil` que guarda a promessa. */
function pushEvent(data: unknown) {
  const waits: Promise<unknown>[] = [];
  return {
    event: {
      data:
        data === undefined
          ? null
          : {
              json: () => {
                if (typeof data === "string") throw new SyntaxError("json inválido");
                return data;
              },
              text: () => String(data),
            },
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    },
    done: () => Promise.all(waits),
  };
}

function clickEvent(data: unknown) {
  const waits: Promise<unknown>[] = [];
  const close = vi.fn();
  return {
    event: { notification: { close, data }, waitUntil: (p: Promise<unknown>) => waits.push(p) },
    close,
    done: () => Promise.all(waits),
  };
}

let sw: ReturnType<typeof load>;
beforeEach(() => {
  sw = load();
});

describe("evento push", () => {
  it("mostra a notificação com título, corpo, tag, ícone da marca e a url nos dados", async () => {
    const { event, done } = pushEvent({
      title: "bia (#geral · Alfa)",
      body: "oi, tudo bem?",
      url: "/channels/12/34",
      tag: "34",
    });
    sw.listeners.push?.(event);
    await done();
    expect(sw.shown).toEqual([
      {
        title: "bia (#geral · Alfa)",
        opts: {
          body: "oi, tudo bem?",
          tag: "34",
          renotify: true,
          icon: "/icon-192.png",
          badge: "/icon-192.png",
          data: { url: "/channels/12/34" },
        },
      },
    ]);
  });

  it("JSON inválido não quebra: mostra um aviso genérico (o Chrome exige notificação visível)", async () => {
    const { event, done } = pushEvent("isto não é json");
    sw.listeners.push?.(event);
    await done();
    expect(sw.shown[0]?.title).toBe("Spook");
    expect(sw.shown[0]?.opts).toMatchObject({ body: "isto não é json", data: { url: "/" } });
  });

  it("push sem dados também mostra o aviso genérico", async () => {
    const { event, done } = pushEvent(undefined);
    sw.listeners.push?.(event);
    await done();
    expect(sw.shown[0]).toMatchObject({ title: "Spook", opts: { body: "", data: { url: "/" } } });
  });

  it("campos de tipo errado e urls de fora do app são descartados", async () => {
    const { event, done } = pushEvent({
      title: 42,
      body: { a: 1 },
      url: "https://evil.test/channels/1/2",
      tag: 7,
    });
    sw.listeners.push?.(event);
    await done();
    expect(sw.shown[0]).toMatchObject({
      title: "Spook",
      opts: { body: "", tag: undefined, renotify: false, data: { url: "/" } },
    });
  });
});

describe("evento notificationclick", () => {
  it("fecha a notificação e, com uma janela do app aberta, foca e manda navegar", async () => {
    sw.windows.push(
      { url: "https://outro.test/", focus: vi.fn(), postMessage: vi.fn() },
      { url: "https://spook.test/channels/1/2", focus: vi.fn(), postMessage: vi.fn() },
    );
    const { event, close, done } = clickEvent({ url: "/channels/@me/99" });
    sw.listeners.notificationclick?.(event);
    await done();
    expect(close).toHaveBeenCalled();
    expect(sw.windows[0]?.focus).not.toHaveBeenCalled(); // de outra origem
    expect(sw.windows[1]?.focus).toHaveBeenCalled();
    expect(sw.windows[1]?.postMessage).toHaveBeenCalledWith({
      type: "spook:navigate",
      url: "/channels/@me/99",
    });
    expect(sw.openWindow).not.toHaveBeenCalled();
  });

  it("sem janela aberta, abre uma nova no canal", async () => {
    const { event, done } = clickEvent({ url: "/channels/12/34" });
    sw.listeners.notificationclick?.(event);
    await done();
    expect(sw.openWindow).toHaveBeenCalledWith("/channels/12/34");
  });

  it("dados ausentes ou url estranha abrem a raiz", async () => {
    for (const data of [null, undefined, { url: "javascript:alert(1)" }, { url: "/etc/passwd" }]) {
      sw = load();
      const { event, done } = clickEvent(data);
      sw.listeners.notificationclick?.(event);
      await done();
      expect(sw.openWindow).toHaveBeenCalledWith("/");
    }
  });
});

describe("ciclo de vida", () => {
  it("assume o controle sem esperar (install/activate)", async () => {
    sw.listeners.install?.({});
    expect(sw.self.skipWaiting).toHaveBeenCalled();
    const waits: Promise<unknown>[] = [];
    sw.listeners.activate?.({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
    expect(sw.self.clients.claim).toHaveBeenCalled();
  });
});
