import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "@/lib/query";
import type { FlowState, VideoTrackInfo } from "../engine";
import { ParticipantTile, type TileModel } from "./participant-tile";
import { FIRST_FRAME_TIMEOUT_MS } from "./stream-health";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

/** Faixa remota cujo `<video>` ainda não tem quadro; `showFrame()` simula o primeiro keyframe decodificado. */
function remoteScreen() {
  let video: HTMLVideoElement | null = null;
  let flow: ((s: FlowState) => void) | null = null;
  const attaches = vi.fn();
  const track: VideoTrackInfo = {
    id: "TR_1",
    identity: "7",
    kind: "screen",
    local: false,
    source: {
      attach(host) {
        attaches();
        const v = document.createElement("video");
        host.appendChild(v);
        video = v;
        return () => v.remove();
      },
      onFlow(cb) {
        flow = cb;
        return () => {
          flow = null;
        };
      },
    },
  };
  return {
    track,
    attaches,
    showFrame() {
      if (!video) throw new Error("vídeo não montado");
      Object.defineProperty(video, "videoWidth", { value: 1920, configurable: true });
      Object.defineProperty(video, "videoHeight", { value: 1080, configurable: true });
      Object.defineProperty(video, "readyState", { value: 4, configurable: true });
    },
    flow: (s: FlowState) => flow?.(s),
  };
}

function renderTile(
  video: VideoTrackInfo,
  extra: Partial<TileModel> = {},
  props: { onWatch?: (id: string, on: boolean) => void } = {},
) {
  const tile: TileModel = {
    key: "s:TR_1",
    userId: "7",
    name: "Bia",
    kind: "screen",
    local: false,
    video,
    ...extra,
  };
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <ul>
        <ParticipantTile tile={tile} speaking={false} channelId={null} {...props} />
      </ul>
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("tile de tela: primeiro quadro", () => {
  it("mostra 'Carregando transmissão…' até o primeiro quadro real e depois some", () => {
    const s = remoteScreen();
    renderTile(s.track);
    expect(screen.getByTestId("stream-loading")).toHaveTextContent("Carregando transmissão…");
    expect(screen.getByTestId("video-tile")).toHaveAttribute("data-frame-state", "waiting");
    s.showFrame();
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.queryByTestId("stream-loading")).toBeNull();
    expect(screen.getByTestId("video-tile")).toHaveAttribute("data-frame-state", "ready");
    expect(screen.getByTestId("video-tile").getAttribute("data-first-frame-ms")).not.toBeNull();
  });

  it("sem quadro no prazo oferece 'Tentar de novo', que reassina a tela (parar e assistir)", () => {
    const s = remoteScreen();
    const onWatch = vi.fn();
    renderTile(s.track, { canStopWatching: true }, { onWatch });
    act(() => {
      vi.advanceTimersByTime(FIRST_FRAME_TIMEOUT_MS + 300);
    });
    expect(screen.getByText("A transmissão não chegou.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(onWatch).toHaveBeenCalledWith("7", false);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(onWatch).toHaveBeenLastCalledWith("7", true);
  });

  it("sem escolha de assinatura (desktop), tentar de novo remonta o vídeo", () => {
    const s = remoteScreen();
    renderTile(s.track);
    expect(s.attaches).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(FIRST_FRAME_TIMEOUT_MS + 300);
    });
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(s.attaches).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("video-tile")).toHaveAttribute("data-frame-state", "waiting");
  });

  it("a minha própria tela não espera quadro nem mostra o carregando", () => {
    const s = remoteScreen();
    renderTile({ ...s.track, local: true }, { local: true });
    expect(screen.queryByTestId("stream-loading")).toBeNull();
  });

  it("pausa do SFU ou tela silenciada avisa sem esconder o vídeo", () => {
    const s = remoteScreen();
    renderTile(s.track);
    s.showFrame();
    act(() => {
      vi.advanceTimersByTime(300);
    });
    act(() => s.flow("paused"));
    expect(screen.getByRole("status")).toHaveTextContent("Transmissão pausada");
    act(() => s.flow("muted"));
    expect(screen.getByRole("status")).toHaveTextContent("A pessoa pausou a transmissão");
    act(() => s.flow("flowing"));
    expect(screen.queryByRole("status")).toBeNull();
  });
});
