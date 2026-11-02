import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { renderApp } from "@/test/render";
import { SPLASH_MAX_MS, SPLASH_MIN_MS, UpdateSplash } from "./update-splash";
import { UpdateWatcher } from "./update-watcher";
import {
  createUpdater,
  type PendingUpdate,
  type Updater,
  type UpdaterBackend,
  updater,
} from "./updater";
import { UpdatesSection } from "./updates-section";

type Deferred = { promise: Promise<void>; resolve: () => void };
const deferred = (): Deferred => {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

function make(opts: {
  found?: boolean;
  checkGate?: Deferred;
  downloadGate?: Deferred;
  checkError?: string;
  inCall?: boolean;
}) {
  const install = vi.fn(async () => {});
  const relaunch = vi.fn(async () => {});
  const update: PendingUpdate = {
    version: "2.0.0",
    download: async (onProgress) => {
      onProgress(30, 100);
      await opts.downloadGate?.promise;
      onProgress(100, 100);
    },
    install,
  };
  const backend: UpdaterBackend = {
    check: async () => {
      await opts.checkGate?.promise;
      if (opts.checkError) throw opts.checkError;
      return opts.found ? update : null;
    },
    relaunch,
    currentVersion: async () => "1.0.0",
  };
  const u = createUpdater(backend, { inCall: () => opts.inCall ?? false });
  return { u, install, relaunch };
}

const wrap = (ui: React.ReactNode) => <ThemeProvider>{ui}</ThemeProvider>;

describe("UpdateSplash", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sem atualização some rápido, respeitando o tempo mínimo", async () => {
    const { u } = make({});
    render(wrap(<UpdateSplash updater={u} />));
    expect(screen.getByText("Verificando atualizações…")).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(SPLASH_MIN_MS - 50));
    expect(screen.getByTestId("update-splash")).toHaveClass("opacity-100");
    await act(() => vi.advanceTimersByTimeAsync(60));
    expect(screen.getByTestId("update-splash")).toHaveClass("opacity-0");
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(screen.queryByTestId("update-splash")).not.toBeInTheDocument();
  });

  it("offline (erro silencioso) segue para o app dentro do limite", async () => {
    const { u } = make({ checkError: "error sending request" });
    render(wrap(<UpdateSplash updater={u} />));
    await act(() => vi.advanceTimersByTimeAsync(SPLASH_MAX_MS));
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(screen.queryByTestId("update-splash")).not.toBeInTheDocument();
  });

  it("verificação lenta: some em 1,5 s e a checagem continua em segundo plano", async () => {
    const gate = deferred();
    const { u } = make({ checkGate: gate });
    render(wrap(<UpdateSplash updater={u} />));
    await act(() => vi.advanceTimersByTimeAsync(SPLASH_MAX_MS));
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(screen.queryByTestId("update-splash")).not.toBeInTheDocument();
    expect(u.getStatus().kind).toBe("checking");
  });

  it("com atualização mostra o download e deixa continuar usando o app", async () => {
    const downloadGate = deferred();
    const { u, relaunch } = make({ found: true, downloadGate });
    render(wrap(<UpdateSplash updater={u} />));
    await act(() => vi.advanceTimersByTimeAsync(SPLASH_MAX_MS + 100));
    expect(screen.getByText(/Baixando a versão 2\.0\.0: 30%/)).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "30");
    fireEvent.click(screen.getByRole("button", { name: "Continuar usando o app" }));
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(screen.queryByTestId("update-splash")).not.toBeInTheDocument();
    // terminar o download depois não reinicia sozinho
    downloadGate.resolve();
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(u.getStatus().kind).toBe("ready");
    expect(relaunch).not.toHaveBeenCalled();
  });

  it("baixou ainda na abertura: instala e reinicia sozinho", async () => {
    const { u, install, relaunch } = make({ found: true });
    render(wrap(<UpdateSplash updater={u} />));
    await act(() => vi.advanceTimersByTimeAsync(50));
    expect(install).toHaveBeenCalledTimes(1);
    expect(relaunch).toHaveBeenCalledTimes(1);
  });
});

describe("UpdatesSection", () => {
  it("mostra a versão, verifica e mostra 'em dia'", async () => {
    const { u } = make({});
    render(wrap(<UpdatesSection updater={u} />));
    expect(await screen.findByText("v1.0.0")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Verificar atualizações/ }));
    expect(await screen.findByText(/versão mais recente/)).toBeInTheDocument();
  });

  it("erro manual aparece como alerta com mensagem clara", async () => {
    const { u } = make({ checkError: "error sending request" });
    render(wrap(<UpdatesSection updater={u} />));
    await userEvent.click(screen.getByRole("button", { name: /Verificar atualizações/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Sem conexão");
  });

  it("baixou: botão 'Reiniciar para atualizar' instala e reinicia", async () => {
    const { u, install, relaunch } = make({ found: true });
    render(wrap(<UpdatesSection updater={u} />));
    await userEvent.click(screen.getByRole("button", { name: /Verificar atualizações/ }));
    const restart = await screen.findByRole("button", { name: "Reiniciar para atualizar" });
    expect(screen.getByRole("button", { name: /Verificar atualizações/ })).toBeDisabled();
    await userEvent.click(restart);
    await waitFor(() => expect(relaunch).toHaveBeenCalledTimes(1));
    expect(install).toHaveBeenCalledTimes(1);
  });

  it("falha no download oferece tentar de novo", async () => {
    const backend: UpdaterBackend = {
      check: async () => ({
        version: "2.0.0",
        download: async () => {
          throw new Error("signature mismatch");
        },
        install: async () => {},
      }),
      relaunch: async () => {},
      currentVersion: async () => "1.0.0",
    };
    const u = createUpdater(backend);
    render(wrap(<UpdatesSection updater={u} />));
    await userEvent.click(screen.getByRole("button", { name: /Verificar atualizações/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("assinatura");
    expect(screen.getByRole("button", { name: "Tentar de novo" })).toBeInTheDocument();
  });
});

describe("UpdateWatcher", () => {
  function mount(u: Updater) {
    return render(
      wrap(
        <>
          <UpdateWatcher updater={u} />
          <Toaster />
        </>,
      ),
    );
  }

  it("avisa com um toast quando a versão está pronta e o botão reinicia", async () => {
    const { u, relaunch } = make({ found: true });
    mount(u);
    await act(() => u.check());
    expect(await screen.findByText("Spook 2.0.0 está pronto")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Reiniciar para atualizar" }));
    await waitFor(() => expect(relaunch).toHaveBeenCalledTimes(1));
  });

  it("em chamada de voz pede confirmação antes de reiniciar", async () => {
    const { u, relaunch } = make({ found: true, inCall: true });
    mount(u);
    await act(() => u.check());
    await userEvent.click(await screen.findByRole("button", { name: "Reiniciar para atualizar" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Reiniciar durante a chamada?");
    expect(relaunch).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Agora não" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(relaunch).not.toHaveBeenCalled();

    await act(() => u.requestRestart());
    await userEvent.click(
      await screen.findByRole("button", { name: "Reiniciar e sair da chamada" }, { timeout: 4000 }),
    );
    await waitFor(() => expect(relaunch).toHaveBeenCalledTimes(1));
  });
});

describe("/settings/app no desktop", () => {
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    updater.setBackend(null);
  });

  it("mostra a seção Atualizações com a versão instalada", async () => {
    Object.assign(window, { __TAURI_INTERNALS__: {} });
    const { u } = make({});
    updater.setBackend({
      check: () => u.currentVersion().then(() => null),
      relaunch: async () => {},
      currentVersion: async () => "0.1.0",
    });
    await renderApp("/settings/app", { signedIn: true });
    expect(await screen.findByRole("heading", { name: "Atualizações" })).toBeInTheDocument();
    expect(await screen.findByText("v0.1.0")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Verificar atualizações/ }));
    expect(await screen.findByText(/versão mais recente/)).toBeInTheDocument();
  });
});
