import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamStats, VideoTrackInfo } from "../engine";
import {
  loadStatsOpen,
  STATS_POLL_MS,
  StreamStatsPanel,
  saveStatsOpen,
  useStreamStats,
} from "./stream-stats";

const stats = (over: Partial<StreamStats> = {}): StreamStats => ({
  role: "receive",
  width: 1920,
  height: 1080,
  fps: 30,
  bitrateKbps: 4800,
  codec: "VP8",
  limitation: null,
  layer: "single",
  subscription: "subscribed",
  ...over,
});

describe("StreamStatsPanel", () => {
  it("mostra resolução, fps, bitrate, codec e o tempo até o primeiro quadro", () => {
    render(<StreamStatsPanel stats={stats()} firstFrameMs={840} />);
    const panel = screen.getByTestId("stream-stats");
    expect(panel).toHaveTextContent("1920×1080");
    expect(panel).toHaveTextContent("4.8 Mbps");
    expect(panel).toHaveTextContent("840 ms");
    expect(panel).toHaveAttribute("data-height", "1080");
    expect(panel).toHaveAttribute("data-kbps", "4800");
  });

  it("quem transmite vê o motivo de limitação do codificador", () => {
    render(
      <StreamStatsPanel
        stats={stats({ role: "send", limitation: "bandwidth" })}
        firstFrameMs={null}
      />,
    );
    expect(screen.getByTestId("stream-stats")).toHaveTextContent("banda");
    expect(screen.getByTestId("stream-stats")).toHaveAttribute("data-limitation", "bandwidth");
  });

  it("sem dados mostra travessões em vez de zeros", () => {
    render(<StreamStatsPanel stats={null} firstFrameMs={null} />);
    expect(screen.getByTestId("stream-stats")).toHaveTextContent("—");
  });
});

describe("useStreamStats", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function Probe({ track, on }: { track?: VideoTrackInfo; on: boolean }) {
    const s = useStreamStats(track, on);
    return <p data-testid="out">{s ? `${s.width}x${s.height}` : "nada"}</p>;
  }
  const track = (read: () => Promise<StreamStats | null>): VideoTrackInfo => ({
    id: "t",
    identity: "u",
    kind: "screen",
    local: false,
    source: { attach: () => () => {}, stats: read },
  });

  it("lê ao abrir e a cada segundo, e para quando desligado", async () => {
    const read = vi.fn(async () => stats());
    const { rerender } = render(<Probe track={track(read)} on />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId("out")).toHaveTextContent("1920x1080");
    const first = read.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STATS_POLL_MS * 3);
    });
    expect(read.mock.calls.length).toBe(first + 3);
    const t = track(read);
    rerender(<Probe track={t} on={false} />);
    const after = read.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STATS_POLL_MS * 3);
    });
    expect(read.mock.calls.length).toBe(after);
  });

  it("erro na leitura não derruba nada", async () => {
    render(<Probe track={track(async () => Promise.reject(new Error("acabou")))} on />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STATS_POLL_MS * 2);
    });
    expect(screen.getByTestId("out")).toHaveTextContent("nada");
  });
});

describe("preferência do painel", () => {
  it("lembra aberto/fechado e tolera armazenamento indisponível", () => {
    saveStatsOpen(true);
    expect(loadStatsOpen()).toBe(true);
    saveStatsOpen(false);
    expect(loadStatsOpen()).toBe(false);
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("bloqueado");
    });
    expect(loadStatsOpen()).toBe(false);
    get.mockRestore();
  });
});
