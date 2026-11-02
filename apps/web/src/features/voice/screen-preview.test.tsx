import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Backend, makeBackend, server } from "@/test/server";
import type { VideoSource } from "./engine";
import {
  captureScreenFrame,
  PREVIEW_HEIGHT,
  PREVIEW_MAX_BYTES,
  PREVIEW_WIDTH,
  startScreenPreview,
  useStreamPreview,
} from "./screen-preview";

let backend: Backend;
const draws: unknown[][] = [];
let blobSize: (quality: number) => number;
const qualities: number[] = [];

/** jsdom não desenha: canvas de mentira que registra o desenho e devolve um JPEG do tamanho pedido. */
function stubCanvas() {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    fillRect: () => {},
    drawImage: (...a: unknown[]) => void draws.push(a),
    fillStyle: "",
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((cb, type, q) => {
    qualities.push(q as number);
    cb(new Blob([new Uint8Array(blobSize(q as number))], { type }));
  });
}

/** Fonte que monta um <video> já com quadro (como a engine web depois do primeiro frame). */
function videoSource(width: number, height: number, readyAfterMs = 0): VideoSource {
  return {
    attach(host) {
      const v = document.createElement("video");
      Object.defineProperty(v, "videoWidth", { value: width });
      Object.defineProperty(v, "videoHeight", { value: height });
      let ready = readyAfterMs === 0;
      Object.defineProperty(v, "readyState", { get: () => (ready ? 4 : 0) });
      if (!ready)
        setTimeout(() => {
          ready = true;
        }, readyAfterMs);
      host.appendChild(v);
      return () => v.remove();
    },
  };
}

beforeEach(() => {
  draws.length = 0;
  qualities.length = 0;
  blobSize = () => 8_000;
  backend = makeBackend({ signedIn: true });
  server.use(...backend.handlers);
  stubCanvas();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("captureScreenFrame", () => {
  it("desenha o quadro em 320x180 com barras (proporção mantida) e devolve JPEG q0,6 dentro do limite", async () => {
    const blob = await captureScreenFrame(videoSource(1920, 1200));
    expect(blob?.type).toBe("image/jpeg");
    expect(blob?.size).toBeLessThanOrEqual(PREVIEW_MAX_BYTES);
    expect(qualities).toEqual([0.6]);
    // 1920x1200 (16:10) cabe em 288x180, centralizado com 16 px de barra de cada lado
    const [, x, y, w, h] = draws[0] as number[];
    expect({ x, y, w, h }).toEqual({ x: 16, y: 0, w: 288, h: 180 });
    expect(PREVIEW_WIDTH).toBe(320);
    expect(PREVIEW_HEIGHT).toBe(180);
  });

  it("baixa a qualidade até caber em 40 KB; se nem a menor couber, desiste", async () => {
    blobSize = (q) => (q >= 0.6 ? 60_000 : q >= 0.45 ? 45_000 : 30_000);
    const blob = await captureScreenFrame(videoSource(1280, 720));
    expect(qualities).toEqual([0.6, 0.45, 0.3]);
    expect(blob?.size).toBe(30_000);
    qualities.length = 0;
    blobSize = () => 90_000;
    expect(await captureScreenFrame(videoSource(1280, 720))).toBeNull();
  });

  it("espera o primeiro quadro do vídeo e desiste se ele nunca vem", async () => {
    vi.useFakeTimers();
    const slow = captureScreenFrame(videoSource(1280, 720, 400));
    await vi.advanceTimersByTimeAsync(500);
    expect((await slow)?.size).toBe(8_000);
    const never = captureScreenFrame(videoSource(1280, 720, 60_000));
    await vi.advanceTimersByTimeAsync(3_200);
    expect(await never).toBeNull();
  });

  it("não deixa nada na página (host e vídeo são desmontados) nem desenha sem tamanho", async () => {
    await captureScreenFrame(videoSource(1280, 720));
    expect(document.body.querySelector("video")).toBeNull();
    expect(await captureScreenFrame(videoSource(0, 0))).toBeNull();
    expect(document.body.querySelector("video")).toBeNull();
  });
});

describe("startScreenPreview", () => {
  const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

  it("envia ao entrar (~0,5 s) e a cada 15 s; parar apaga a prévia e silencia", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const stop = startScreenPreview("c1", () => videoSource(1280, 720));
    expect(backend.state.voice.previewPuts).toHaveLength(0);
    await advance(600);
    await vi.waitFor(() => expect(backend.state.voice.previewPuts).toHaveLength(1));
    // (o tamanho do corpo não é conferido: o Blob do jsdom não passa pelo fetch do Node como no navegador)
    expect(backend.state.voice.previewPuts[0]).toMatchObject({
      channelId: "c1",
      type: "image/jpeg",
    });
    await advance(14_000);
    expect(backend.state.voice.previewPuts).toHaveLength(1);
    await advance(1_500);
    await vi.waitFor(() => expect(backend.state.voice.previewPuts).toHaveLength(2));
    stop();
    await vi.waitFor(() => expect(backend.state.voice.previewDeletes).toEqual(["c1"]));
    await advance(60_000);
    expect(backend.state.voice.previewPuts).toHaveLength(2);
  });

  it("sem fonte de vídeo ainda: tenta de novo em poucos segundos, sem enviar nada", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let source: VideoSource | undefined;
    const stop = startScreenPreview("c1", () => source);
    await advance(600);
    expect(backend.state.voice.previewPuts).toHaveLength(0);
    source = videoSource(1280, 720);
    await advance(3_100);
    await vi.waitFor(() => expect(backend.state.voice.previewPuts).toHaveLength(1));
    stop(false);
    expect(backend.state.voice.previewDeletes).toEqual([]); // `remote: false` só para
  });

  it("envio recusado (403/429): tenta de novo em 3 s e depois volta ao ritmo normal", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    backend.state.voice.previewPutStatus = 403;
    const stop = startScreenPreview("c1", () => videoSource(1280, 720));
    await advance(600);
    await vi.waitFor(() => expect(backend.state.voice.previewPuts).toHaveLength(1));
    backend.state.voice.previewPutStatus = 204;
    await advance(3_100);
    await vi.waitFor(() => expect(backend.state.voice.previewPuts).toHaveLength(2));
    await advance(14_000);
    expect(backend.state.voice.previewPuts).toHaveLength(2);
    stop(false);
  });
});

describe("useStreamPreview (quem assiste)", () => {
  function Probe({ enabled = true }: { enabled?: boolean }) {
    const p = useStreamPreview("c1", "7", enabled);
    return <output data-testid="p">{p.status === "ready" ? `ready:${p.url}` : p.status}</output>;
  }

  beforeEach(() => {
    let n = 0;
    URL.createObjectURL = vi.fn(() => `blob:preview-${++n}`);
    URL.revokeObjectURL = vi.fn();
  });

  it("busca a miniatura com cache desligado e mostra; 404 vira 'none'", async () => {
    backend.state.voice.previews["c1/7"] = [0xff, 0xd8, 0xff, 0xd9];
    const { unmount } = render(<Probe />);
    await waitFor(() => expect(screen.getByTestId("p")).toHaveTextContent("ready:blob:preview-1"));
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview-1");
    backend.state.voice.previews["c1/7"] = undefined;
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId("p")).toHaveTextContent("none"));
  });

  it("recarrega a cada ~15 s enquanto aberto e revoga a URL antiga", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    backend.state.voice.previews["c1/7"] = [0xff, 0xd8, 0xff, 0xd9];
    render(<Probe />);
    await vi.waitFor(() =>
      expect(screen.getByTestId("p")).toHaveTextContent("ready:blob:preview-1"),
    );
    await vi.advanceTimersByTimeAsync(15_100);
    await vi.waitFor(() =>
      expect(screen.getByTestId("p")).toHaveTextContent("ready:blob:preview-2"),
    );
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview-1");
    expect(backend.state.voice.previewGets).toHaveLength(2);
  });

  it("desativado (opção local desligada): não faz requisição nenhuma", async () => {
    render(<Probe enabled={false} />);
    expect(screen.getByTestId("p")).toHaveTextContent("off");
    await new Promise((r) => setTimeout(r, 30));
    expect(backend.state.voice.previewGets).toEqual([]);
  });
});
