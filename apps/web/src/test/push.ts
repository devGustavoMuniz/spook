import { vi } from "vitest";

export type FakeSubscription = {
  endpoint: string;
  toJSON: () => { endpoint: string; keys: { p256dh: string; auth: string } };
  unsubscribe: ReturnType<typeof vi.fn>;
};

/** Inscrição de push falsa (o que `pushManager.subscribe` devolve). */
export function fakeSubscription(endpoint = "https://push.test/abc"): FakeSubscription {
  return {
    endpoint,
    toJSON: () => ({ endpoint, keys: { p256dh: "chave-p256dh", auth: "chave-auth" } }),
    unsubscribe: vi.fn(async () => true),
  };
}

/**
 * Simula `navigator.serviceWorker`, `PushManager` e `Notification` (o Playwright e o jsdom não
 * recebem push de verdade). Devolve os espiões e uma função para desfazer.
 */
export function stubPush(
  opts: {
    permission?: NotificationPermission;
    /** Resposta de `Notification.requestPermission()`. */
    grant?: NotificationPermission;
    subscription?: FakeSubscription | null;
    userAgent?: string;
    standalone?: boolean;
    serviceWorker?: boolean;
  } = {},
) {
  let current = opts.subscription ?? null;
  const state = { permission: opts.permission ?? "default" };
  const requestPermission = vi.fn(async () => {
    state.permission = opts.grant ?? "granted";
    return state.permission;
  });
  const pushManager = {
    getSubscription: vi.fn(async () => current),
    subscribe: vi.fn(async (_o: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }) => {
      current = fakeSubscription();
      return current;
    }),
  };
  const registration = { pushManager };
  const originalNotification = (globalThis as { Notification?: unknown }).Notification;
  const originalSw = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
  const originalUa = Object.getOwnPropertyDescriptor(navigator, "userAgent");
  const originalPush = (window as { PushManager?: unknown }).PushManager;

  const FakeNotification = {
    get permission() {
      return state.permission;
    },
    requestPermission,
  };
  (globalThis as { Notification?: unknown }).Notification = FakeNotification;
  (window as { PushManager?: unknown }).PushManager = class {};
  if (opts.serviceWorker !== false)
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        ready: Promise.resolve(registration),
        getRegistration: vi.fn(async () => registration),
        register: vi.fn(async () => registration),
        addEventListener: vi.fn(),
      },
    });
  else Reflect.deleteProperty(navigator, "serviceWorker");
  if (opts.userAgent)
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: opts.userAgent });
  if (opts.standalone)
    Object.defineProperty(navigator, "standalone", { configurable: true, value: true });

  return {
    pushManager,
    requestPermission,
    state,
    restore() {
      (globalThis as { Notification?: unknown }).Notification = originalNotification;
      (window as { PushManager?: unknown }).PushManager = originalPush;
      if (originalSw) Object.defineProperty(navigator, "serviceWorker", originalSw);
      else Reflect.deleteProperty(navigator, "serviceWorker");
      if (originalUa) Object.defineProperty(navigator, "userAgent", originalUa);
      else Reflect.deleteProperty(navigator, "userAgent"); // volta ao getter do protótipo
      Reflect.deleteProperty(navigator, "standalone");
    },
  };
}
