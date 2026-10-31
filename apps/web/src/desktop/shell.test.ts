import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NOTIFICATION_CLICK_WINDOW_MS,
  rememberNotification,
  resetNativeNotifier,
  sendNativeNotification,
  takeRecentNotification,
} from "./notifier";
import {
  ACTIVATED_EVENT,
  BADGE_DEBOUNCE_MS,
  createBadgeSync,
  installNotificationClick,
  shellErrorMessage,
  tauriActivationSource,
} from "./shell";

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: async () => true,
  requestPermission: async () => "granted",
  sendNotification: vi.fn(),
}));

const tauri = vi.hoisted(() => ({
  focusHandler: null as null | ((e: { payload: boolean }) => void),
  listeners: new Map<string, () => void>(),
  offFocus: vi.fn(),
  offEvent: vi.fn(),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onFocusChanged: async (h: (e: { payload: boolean }) => void) => {
      tauri.focusHandler = h;
      return tauri.offFocus;
    },
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, h: () => void) => {
    tauri.listeners.set(name, h);
    return tauri.offEvent;
  },
}));

beforeEach(() => {
  vi.useFakeTimers();
  resetNativeNotifier();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("contador no ícone: debounce", () => {
  it("manda só o último valor da rajada", async () => {
    const send = vi.fn(async () => {});
    const badge = createBadgeSync(send);
    badge.set(1);
    badge.set(2);
    badge.set(3);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(BADGE_DEBOUNCE_MS);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(3);
  });

  it("não repete o mesmo valor", async () => {
    const send = vi.fn(async () => {});
    const badge = createBadgeSync(send);
    badge.set(4);
    await vi.advanceTimersByTimeAsync(BADGE_DEBOUNCE_MS);
    badge.set(4);
    await vi.advanceTimersByTimeAsync(BADGE_DEBOUNCE_MS);
    expect(send).toHaveBeenCalledTimes(1);
    badge.set(0);
    await vi.advanceTimersByTimeAsync(BADGE_DEBOUNCE_MS);
    expect(send).toHaveBeenLastCalledWith(0);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("flush envia na hora, cancelando o que estava esperando", async () => {
    const send = vi.fn(async () => {});
    const badge = createBadgeSync(send);
    badge.set(9);
    badge.flush(0);
    expect(send).toHaveBeenCalledWith(0);
    await vi.advanceTimersByTimeAsync(BADGE_DEBOUNCE_MS * 2);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("valores estranhos viram inteiros não negativos", async () => {
    const send = vi.fn(async () => {});
    const badge = createBadgeSync(send);
    badge.flush(-3);
    badge.flush(Number.NaN);
    badge.flush(2.9);
    expect(send.mock.calls).toEqual([[0], [2]]);
  });

  it("falha do comando não lança e a próxima tentativa reenvia o mesmo valor", async () => {
    const send = vi
      .fn<(n: number) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error("x"))
      .mockResolvedValue(undefined);
    const badge = createBadgeSync(send);
    badge.flush(5);
    await vi.advanceTimersByTimeAsync(0);
    badge.flush(5);
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe("clicar na notificação: janela de tempo e uso único", () => {
  it("devolve o canal da última notificação dentro do prazo, uma única vez", () => {
    rememberNotification("/channels/@me/5", 1_000);
    expect(takeRecentNotification(1_000 + 3_000)).toBe("/channels/@me/5");
    expect(takeRecentNotification(1_000 + 3_001)).toBeNull();
  });

  it("expira depois do prazo (e o prazo é uma constante)", () => {
    expect(NOTIFICATION_CLICK_WINDOW_MS).toBe(10_000);
    rememberNotification("/channels/1/2", 0);
    expect(takeRecentNotification(NOTIFICATION_CLICK_WINDOW_MS + 1)).toBeNull();
    rememberNotification("/channels/1/2", 0);
    expect(takeRecentNotification(NOTIFICATION_CLICK_WINDOW_MS)).toBe("/channels/1/2");
  });

  it("disparar a notificação nativa registra o canal dela", async () => {
    vi.useRealTimers();
    const ok = await sendNativeNotification({
      channelId: "9",
      title: "Ana",
      body: "oi",
      url: "/channels/@me/9",
      mention: false,
    });
    expect(ok).toBe(true);
    expect(takeRecentNotification()).toBe("/channels/@me/9");
    expect(takeRecentNotification()).toBeNull();
  });

  it("só a notificação mais recente vale", () => {
    rememberNotification("/channels/1/2", 0);
    rememberNotification("/channels/1/3", 500);
    expect(takeRecentNotification(1_000)).toBe("/channels/1/3");
  });

  it("recusa caminhos que não são do app", () => {
    rememberNotification("https://evil.example/", 0);
    expect(takeRecentNotification(1)).toBeNull();
  });
});

describe("installNotificationClick", () => {
  function setup() {
    let activate: () => void = () => {};
    const off = vi.fn();
    const source = vi.fn(async (cb: () => void) => {
      activate = cb;
      return off;
    });
    const navigate = vi.fn();
    const dispose = installNotificationClick(navigate, source);
    return { navigate, off, dispose, focus: () => activate() };
  }

  it("foco logo depois da notificação navega uma única vez", async () => {
    const t = setup();
    await vi.advanceTimersByTimeAsync(0);
    rememberNotification("/channels/@me/9");
    vi.advanceTimersByTime(2_000);
    t.focus();
    t.focus();
    expect(t.navigate).toHaveBeenCalledTimes(1);
    expect(t.navigate).toHaveBeenCalledWith("/channels/@me/9");
  });

  it("foco depois do prazo ou sem notificação não navega", async () => {
    const t = setup();
    await vi.advanceTimersByTimeAsync(0);
    t.focus();
    rememberNotification("/channels/@me/9");
    vi.advanceTimersByTime(NOTIFICATION_CLICK_WINDOW_MS + 1);
    t.focus();
    expect(t.navigate).not.toHaveBeenCalled();
  });

  it("desinstalar solta a escuta, mesmo se a inscrição ainda estava pendente", async () => {
    const t = setup();
    await vi.advanceTimersByTimeAsync(0);
    t.dispose();
    expect(t.off).toHaveBeenCalledTimes(1);
    const late = setup();
    late.dispose(); // antes de a inscrição resolver
    await vi.advanceTimersByTimeAsync(0);
    expect(late.off).toHaveBeenCalledTimes(1);
  });

  it("falha ao escutar não quebra o app", async () => {
    const navigate = vi.fn();
    installNotificationClick(navigate, async () => {
      throw new Error("sem janela");
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("shellErrorMessage", () => {
  it("usa o texto do Rust, a mensagem do Error ou um texto padrão", () => {
    expect(shellErrorMessage("Falhou ao gravar")).toBe("Falhou ao gravar");
    expect(shellErrorMessage(new Error("x"))).toBe("x");
    expect(shellErrorMessage(undefined)).toContain("Não foi possível salvar");
  });
});

describe("tauriActivationSource", () => {
  it("ativa ao ganhar foco (não ao perder) e quando o Rust traz a janela à frente", async () => {
    vi.useRealTimers();
    const cb = vi.fn();
    const off = await tauriActivationSource(cb);
    tauri.focusHandler?.({ payload: false });
    expect(cb).not.toHaveBeenCalled();
    tauri.focusHandler?.({ payload: true });
    expect(cb).toHaveBeenCalledTimes(1);
    tauri.listeners.get(ACTIVATED_EVENT)?.();
    expect(cb).toHaveBeenCalledTimes(2);
    off();
    expect(tauri.offFocus).toHaveBeenCalled();
    expect(tauri.offEvent).toHaveBeenCalled();
  });
});
