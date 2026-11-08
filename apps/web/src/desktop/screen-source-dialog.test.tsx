import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Channel = (m: unknown) => void;
const ipc = vi.hoisted(() => ({
  channel: null as null | ((m: unknown) => void),
  invoke: vi.fn(async (_cmd: string, _args?: Record<string, unknown>) => undefined as unknown),
  createChannel: vi.fn(async (fn: (m: unknown) => void) => {
    ipc.channel = fn;
    return { onmessage: fn };
  }),
}));
vi.mock("./ipc", () => ({ invoke: ipc.invoke, createChannel: ipc.createChannel }));

import {
  PORTAL_SOURCE,
  pickScreenSource,
  resetScreenPicker,
  type ScreenSource,
} from "./screen-picker";
import { ScreenSourceDialog } from "./screen-source-dialog";
import { refreshIntervalMs } from "./screen-thumbnails";

const sources: ScreenSource[] = [
  { id: "display:1", name: "Tela 1", kind: "screen" },
  { id: "display:2", name: "Tela 2", kind: "screen" },
  { id: "window:9", name: "Navegador - Spook", kind: "window" },
];

const push = (m: Record<string, unknown>) => act(() => ipc.channel?.(m));

beforeEach(() => {
  ipc.channel = null;
  ipc.invoke.mockClear();
  ipc.createChannel.mockClear();
});
afterEach(() => resetScreenPicker());

describe("seletor de fonte de compartilhamento", () => {
  it("sem diálogo montado, cancela em vez de travar", async () => {
    expect(await pickScreenSource(sources)).toBeNull();
  });

  it("no Linux (portal) não abre diálogo: o seletor é do sistema", async () => {
    expect(
      await pickScreenSource([{ id: PORTAL_SOURCE, name: "Escolher no seletor", kind: "screen" }]),
    ).toBe(PORTAL_SOURCE);
  });

  it("lista telas e janelas em seções, com a primeira opção marcada", async () => {
    render(<ScreenSourceDialog />);
    void pickScreenSource(sources);
    expect(
      await screen.findByRole("dialog", { name: "O que você quer compartilhar?" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Telas" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Janelas" })).toBeInTheDocument();
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(3);
    expect(screen.getByRole("radio", { name: "Tela 1" })).toBeChecked();
  });

  it("escolher uma janela e compartilhar devolve o id", async () => {
    const user = userEvent.setup();
    render(<ScreenSourceDialog />);
    const result = pickScreenSource(sources);
    await user.click(await screen.findByRole("radio", { name: "Navegador - Spook" }));
    await user.click(screen.getByRole("button", { name: "Compartilhar" }));
    expect(await result).toBe("window:9");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("Cancelar e Esc devolvem null", async () => {
    const user = userEvent.setup();
    render(<ScreenSourceDialog />);
    const a = pickScreenSource(sources);
    await user.click(await screen.findByRole("button", { name: "Cancelar" }));
    expect(await a).toBeNull();
    const b = pickScreenSource(sources);
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    expect(await b).toBeNull();
  });

  it("sem nenhuma fonte, avisa e não deixa compartilhar", async () => {
    render(<ScreenSourceDialog />);
    void pickScreenSource([]);
    expect(await screen.findByText("Nenhuma tela ou janela disponível.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Compartilhar" })).toBeDisabled();
  });

  it("mostra skeletons e troca pela miniatura quando ela chega", async () => {
    render(<ScreenSourceDialog />);
    void pickScreenSource(sources);
    await screen.findByRole("dialog");
    expect(screen.getAllByTestId("thumb-skeleton")).toHaveLength(3);
    await waitFor(() =>
      expect(ipc.invoke).toHaveBeenCalledWith("voice_screen_source_thumbnails", {
        ids: ["display:1", "display:2", "window:9"],
        thumbnails: expect.anything(),
      }),
    );
    await push({ id: "display:2", jpeg: "AQID", width: 320, height: 180 });
    const card = screen.getByRole("radio", { name: "Tela 2" });
    expect(card.querySelector("img")?.getAttribute("src")).toBe("data:image/jpeg;base64,AQID");
    expect(screen.getAllByTestId("thumb-skeleton")).toHaveLength(2);
  });

  it("fonte sem miniatura mostra o placeholder e continua selecionável", async () => {
    const user = userEvent.setup();
    render(<ScreenSourceDialog />);
    const result = pickScreenSource(sources);
    await screen.findByRole("dialog");
    await waitFor(() => expect(ipc.channel).not.toBeNull());
    await push({ id: "window:9", width: 0, height: 0, error: "timeout" });
    expect(screen.getByText("Sem prévia")).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "Navegador - Spook" }));
    await user.click(screen.getByRole("button", { name: "Compartilhar" }));
    expect(await result).toBe("window:9");
  });

  it("sem permissão de gravação de tela, avisa e oferece abrir as preferências", async () => {
    const user = userEvent.setup();
    render(<ScreenSourceDialog />);
    void pickScreenSource(sources);
    await screen.findByRole("dialog");
    await waitFor(() => expect(ipc.channel).not.toBeNull());
    await push({ id: "display:1", width: 0, height: 0, error: "permission" });
    expect(await screen.findByRole("alert")).toHaveTextContent(/Permita a gravação de tela/);
    await user.click(screen.getByRole("button", { name: "Abrir as preferências" }));
    expect(ipc.invoke).toHaveBeenCalledWith("app_open_screen_recording_settings");
  });

  it("setas movem a seleção, Enter confirma", async () => {
    const user = userEvent.setup();
    render(<ScreenSourceDialog />);
    const result = pickScreenSource(sources);
    const first = await screen.findByRole("radio", { name: "Tela 1" });
    first.focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "Tela 2" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Tela 2" })).toHaveFocus();
    await user.keyboard("{ArrowDown}{ArrowLeft}{ArrowLeft}");
    expect(screen.getByRole("radio", { name: "Tela 1" })).toHaveAttribute("aria-checked", "true");
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("radio", { name: "Navegador - Spook" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(await result).toBe("window:9");
  });

  it("duplo clique no cartão confirma", async () => {
    const user = userEvent.setup();
    render(<ScreenSourceDialog />);
    const result = pickScreenSource(sources);
    await user.dblClick(await screen.findByRole("radio", { name: "Tela 2" }));
    expect(await result).toBe("display:2");
  });

  it("ao fechar, cancela as miniaturas no Rust", async () => {
    const user = userEvent.setup();
    render(<ScreenSourceDialog />);
    void pickScreenSource(sources);
    await user.click(await screen.findByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(ipc.invoke).toHaveBeenCalledWith("voice_cancel_screen_thumbnails"));
  });

  it("entrada do portal (Linux) misturada na lista não pede miniatura", async () => {
    render(<ScreenSourceDialog />);
    void pickScreenSource([
      { id: PORTAL_SOURCE, name: "Escolher no seletor do sistema", kind: "screen" },
      { id: "display:1", name: "Tela 1", kind: "screen" },
    ]);
    await screen.findByRole("radio", { name: "Escolher no seletor do sistema" });
    await waitFor(() =>
      expect(ipc.invoke).toHaveBeenCalledWith("voice_screen_source_thumbnails", {
        ids: ["display:1"],
        thumbnails: expect.anything(),
      }),
    );
  });

  it("no Windows a prévia não é atualizada em loop (a borda amarela piscaria)", () => {
    expect(refreshIntervalMs("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBeNull();
    expect(refreshIntervalMs("Mozilla/5.0 (Macintosh; Intel Mac OS X)")).toBe(3000);
  });
});

describe("atualização periódica das miniaturas", () => {
  it("repete a cada intervalo e para ao cancelar", async () => {
    vi.useFakeTimers();
    try {
      const { startScreenThumbnails } = await import("./screen-thumbnails");
      const deps = {
        invoke: vi.fn(async () => undefined) as never,
        createChannel: vi.fn(async (fn: Channel) => ({ onmessage: fn })) as never,
      };
      const stop = startScreenThumbnails(["display:1"], () => {}, 3000, deps);
      await vi.advanceTimersByTimeAsync(0);
      expect((deps as { invoke: ReturnType<typeof vi.fn> }).invoke).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(3000);
      expect((deps as { invoke: ReturnType<typeof vi.fn> }).invoke).toHaveBeenCalledTimes(2);
      stop();
      await vi.advanceTimersByTimeAsync(10000);
      // 2 capturas + 1 cancelamento
      expect((deps as { invoke: ReturnType<typeof vi.fn> }).invoke).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
