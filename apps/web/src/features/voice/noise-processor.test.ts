import { afterEach, describe, expect, it, vi } from "vitest";
import { LoadMonitor, MicTrackProcessor, resetNoiseProcessorCache } from "./noise-processor";

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetNoiseProcessorCache();
});

/** Relógios controlados: `ctxRate` = quanto do tempo real o áudio consegue renderizar (1 = tempo real). */
function monitorSetup(opts?: { strikes?: number }) {
  const c = { wall: 0, ctx: 0, running: true };
  const events: string[] = [];
  const m = new LoadMonitor(
    { wall: () => c.wall, ctx: () => c.ctx, running: () => c.running },
    { onLoad: (l) => events.push(`load:${l}`), onSlow: () => events.push("slow") },
    { threshold: 0.9, strikes: opts?.strikes ?? 3 },
  );
  const advance = (seconds: number, ctxRate: number) => {
    c.wall += seconds;
    c.ctx += seconds * ctxRate;
    m.tick();
  };
  return { c, events, advance };
}

describe("LoadMonitor (processamento lento demais)", () => {
  it("em tempo real não avisa nada", () => {
    const { events, advance } = monitorSetup();
    for (let i = 0; i < 10; i++) advance(2, 1);
    expect(events).toEqual([]);
  });

  it("uma janela lenta marca carga alta; voltar ao normal limpa", () => {
    const { events, advance } = monitorSetup();
    advance(2, 0.6);
    advance(2, 1);
    expect(events).toEqual(["load:high", "load:ok"]);
  });

  it("janelas lentas seguidas pedem rebaixamento; uma janela boa zera a contagem", () => {
    const { events, advance } = monitorSetup();
    advance(2, 0.5);
    advance(2, 0.5);
    advance(2, 1); // recuperou: zera
    advance(2, 0.5);
    advance(2, 0.5);
    expect(events).not.toContain("slow");
    advance(2, 0.5);
    expect(events).toContain("slow");
  });

  it("contexto suspenso não conta como lentidão", () => {
    const { c, events, advance } = monitorSetup();
    c.running = false;
    for (let i = 0; i < 6; i++) advance(2, 0);
    expect(events).toEqual([]);
  });
});

describe("MicTrackProcessor", () => {
  it("expõe o formato de processador de track da lib", () => {
    const p = new MicTrackProcessor({
      strong: true,
      sensitivity: { mode: "off", thresholdDb: -50 },
    });
    expect(p.name).toBe("spook-mic");
    expect(p.processedTrack).toBeUndefined();
  });

  it("download dos assets que falha não fica em cache: a tentativa seguinte baixa de novo", async () => {
    // a lib estende `AudioWorkletNode` ao ser carregada: o jsdom não tem
    vi.stubGlobal("AudioWorkletNode", class {});
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("sem rede"));
    const p = new MicTrackProcessor({
      strong: true,
      sensitivity: { mode: "off", thresholdDb: -50 },
    });
    await expect(p.init({ track: {} as MediaStreamTrack })).rejects.toThrow();
    const first = fetchMock.mock.calls.length;
    expect(first).toBeGreaterThan(0);
    await expect(p.init({ track: {} as MediaStreamTrack })).rejects.toThrow();
    expect(fetchMock.mock.calls.length).toBeGreaterThan(first);
  });

  it("destroy é idempotente e seguro sem init", async () => {
    const p = new MicTrackProcessor({
      strong: true,
      sensitivity: { mode: "off", thresholdDb: -50 },
    });
    await p.destroy();
    await p.destroy();
  });
});

describe("MicTrackProcessor: grafo da porta de ruído (sem RNNoise)", () => {
  function stubGraph() {
    const nodes: {
      kind: string;
      port?: { posted: unknown[]; onmessage: unknown; postMessage(m: unknown): void };
    }[] = [];
    class FakeNode {
      port = {
        posted: [] as unknown[],
        onmessage: null as unknown,
        postMessage(m: unknown) {
          this.posted.push(m);
        },
      };
      connected: unknown[] = [];
      connect(n: unknown) {
        this.connected.push(n);
      }
      disconnect() {}
      constructor(
        public ctx: unknown,
        public name: string,
        public options: unknown,
      ) {
        nodes.push({ kind: "worklet", port: this.port });
      }
    }
    class FakeCtx {
      sampleRate = 48_000;
      state = "running";
      currentTime = 0;
      modules: string[] = [];
      audioWorklet = { addModule: async (u: string) => void this.modules.push(u) };
      createMediaStreamSource() {
        return { connect() {}, disconnect() {} };
      }
      createMediaStreamDestination() {
        return { stream: { getAudioTracks: () => [{ stop() {} }] } };
      }
      async close() {}
      constructor() {
        ctxs.push(this);
      }
    }
    const ctxs: FakeCtx[] = [];
    vi.stubGlobal("AudioContext", FakeCtx);
    vi.stubGlobal("AudioWorkletNode", FakeNode);
    vi.stubGlobal(
      "MediaStream",
      class {
        constructor(public t: unknown[]) {}
      },
    );
    return { nodes, ctxs };
  }

  it("monta microfone -> porta -> faixa processada, sem carregar o WASM, e repassa os níveis", async () => {
    const { nodes, ctxs } = stubGraph();
    const levels: unknown[] = [];
    const p = new MicTrackProcessor({
      strong: false,
      sensitivity: { mode: "manual", thresholdDb: -42 },
      onLevel: (l) => levels.push(l),
    });
    await p.init({ track: {} as MediaStreamTrack });
    expect(p.processedTrack).toBeDefined();
    expect(ctxs[0]?.modules).toHaveLength(1); // só o worklet da porta
    const port = nodes[0]?.port;
    (port?.onmessage as (e: { data: unknown }) => void)({
      data: { type: "level", db: -33.5, open: true },
    });
    expect(levels).toEqual([{ db: -33.5, gateOpen: true }]);
    p.configure({ mode: "auto", thresholdDb: -42 });
    expect(port?.posted).toEqual([{ type: "config", mode: "auto", thresholdDb: -42 }]);
    await p.destroy();
    expect(p.processedTrack).toBeUndefined();
  });
});
