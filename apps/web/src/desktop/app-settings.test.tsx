import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "@/test/render";
import { DesktopShell } from "./desktop-shell";
import * as ipc from "./ipc";
import { resetNativeNotifier } from "./notifier";
import type { AppSettings } from "./shell";
import { BADGE_DEBOUNCE_MS } from "./shell";

const mentions = vi.hoisted(() => ({ value: 0 }));
vi.mock("@/features/notifications/badges", async (orig) => ({
  ...(await orig<typeof import("@/features/notifications/badges")>()),
  useTotalMentions: () => mentions.value,
}));

const DEFAULTS: AppSettings = {
  closeToTray: true,
  keepCallOnClose: false,
  startWithSystem: false,
  startMinimized: false,
};

function fakeShell(initial: AppSettings = DEFAULTS) {
  const state = { settings: { ...initial }, calls: [] as { cmd: string; args?: unknown }[] };
  const failNext: { message: string | null } = { message: null };
  vi.spyOn(ipc, "invoke").mockImplementation((async (
    cmd: string,
    args?: Record<string, unknown>,
  ) => {
    state.calls.push({ cmd, args });
    if (cmd === "app_get_settings") return state.settings;
    if (cmd === "app_set_settings") {
      if (failNext.message) {
        const message = failNext.message;
        failNext.message = null;
        throw message;
      }
      state.settings = args?.settings as AppSettings;
      return state.settings;
    }
    if (cmd === "app_set_badge") return { tooltip: "x" };
    throw new Error(`comando inesperado ${cmd}`);
  }) as typeof ipc.invoke);
  return { state, failNext };
}

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

describe("/settings/app", () => {
  it("na web só explica que a página é do app para computador e o link não aparece", async () => {
    await renderApp("/settings/app", { signedIn: true });
    expect(await screen.findByText(/existem só no app para computador/i)).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Aplicativo" })).not.toBeInTheDocument();
  });

  describe("no desktop", () => {
    beforeEach(() => {
      Object.assign(window, { __TAURI_INTERNALS__: {} });
    });

    it("mostra o link, carrega os valores do Rust e cada interruptor chama o comando", async () => {
      const { state } = fakeShell();
      await renderApp("/settings/notifications", { signedIn: true });
      expect(
        within(
          await screen.findByRole("navigation", { name: "Seções das configurações" }),
        ).getByRole("link", { name: "Aplicativo" }),
      ).toBeInTheDocument();
      await userEvent.click(await screen.findByRole("link", { name: "Aplicativo" }));

      const close = await screen.findByRole("switch", { name: /Fechar vai para a bandeja/ });
      const auto = screen.getByRole("switch", { name: /Iniciar com o sistema/ });
      const mini = screen.getByRole("switch", { name: /Iniciar minimizado/ });
      await waitFor(() => expect(close).toBeEnabled());
      expect(close).toBeChecked();
      expect(auto).not.toBeChecked();
      expect(mini).not.toBeChecked();

      await userEvent.click(auto);
      await waitFor(() => expect(auto).toBeChecked());
      await userEvent.click(close);
      await waitFor(() => expect(close).not.toBeChecked());
      await userEvent.click(mini);
      await waitFor(() => expect(mini).toBeChecked());

      const saved = state.calls.filter((c) => c.cmd === "app_set_settings").map((c) => c.args);
      expect(saved).toEqual([
        {
          settings: {
            closeToTray: true,
            keepCallOnClose: false,
            startWithSystem: true,
            startMinimized: false,
          },
        },
        {
          settings: {
            closeToTray: false,
            keepCallOnClose: false,
            startWithSystem: true,
            startMinimized: false,
          },
        },
        {
          settings: {
            closeToTray: false,
            keepCallOnClose: false,
            startWithSystem: true,
            startMinimized: true,
          },
        },
      ]);
    });

    it("falha do Rust mostra o erro e o interruptor volta ao valor anterior", async () => {
      const { failNext } = fakeShell();
      await renderApp("/settings/app", { signedIn: true });
      const auto = await screen.findByRole("switch", { name: /Iniciar com o sistema/ });
      await waitFor(() => expect(auto).toBeEnabled());
      failNext.message = "Não foi possível alterar o início com o sistema: negado";
      await userEvent.click(auto);
      expect(await screen.findByRole("alert")).toHaveTextContent("negado");
      expect(auto).not.toBeChecked();
      // a próxima tentativa limpa o erro
      await userEvent.click(auto);
      await waitFor(() => expect(auto).toBeChecked());
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("falha ao carregar mostra o erro e deixa os interruptores desabilitados", async () => {
      vi.spyOn(ipc, "invoke").mockRejectedValue("sem acesso ao arquivo");
      await renderApp("/settings/app", { signedIn: true });
      expect(await screen.findByRole("alert")).toHaveTextContent("sem acesso ao arquivo");
      expect(screen.getByRole("switch", { name: /Fechar vai para a bandeja/ })).toBeDisabled();
    });
  });
});

describe("DesktopShell: contador e clique na notificação", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    resetNativeNotifier();
    mentions.value = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("manda a contagem de não lidas ao Rust (com debounce) e zera ao desmontar", async () => {
    const { state } = fakeShell();
    mentions.value = 3;
    const navigate = vi.fn();
    const view = render(<DesktopShell navigate={navigate} />);
    expect(state.calls.filter((c) => c.cmd === "app_set_badge")).toHaveLength(0);
    await act(() => vi.advanceTimersByTimeAsync(BADGE_DEBOUNCE_MS));
    expect(state.calls.filter((c) => c.cmd === "app_set_badge").map((c) => c.args)).toEqual([
      { count: 3 },
    ]);
    mentions.value = 5;
    view.rerender(<DesktopShell navigate={navigate} />);
    await act(() => vi.advanceTimersByTimeAsync(BADGE_DEBOUNCE_MS));
    expect(state.calls.filter((c) => c.cmd === "app_set_badge").at(-1)?.args).toEqual({
      count: 5,
    });
    view.unmount();
    expect(state.calls.filter((c) => c.cmd === "app_set_badge").at(-1)?.args).toEqual({
      count: 0,
    });
  });
});
