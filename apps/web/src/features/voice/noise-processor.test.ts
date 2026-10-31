import { afterEach, describe, expect, it, vi } from "vitest";
import { LoadMonitor, RnnoiseTrackProcessor, resetNoiseProcessorCache } from "./noise-processor";

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

describe("RnnoiseTrackProcessor", () => {
  it("expõe o formato de processador de track da lib", () => {
    const p = new RnnoiseTrackProcessor();
    expect(p.name).toBe("spook-rnnoise");
    expect(p.processedTrack).toBeUndefined();
  });

  it("download dos assets que falha não fica em cache: a tentativa seguinte baixa de novo", async () => {
    // a lib estende `AudioWorkletNode` ao ser carregada: o jsdom não tem
    vi.stubGlobal("AudioWorkletNode", class {});
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("sem rede"));
    const p = new RnnoiseTrackProcessor();
    await expect(p.init({ track: {} as MediaStreamTrack })).rejects.toThrow();
    const first = fetchMock.mock.calls.length;
    expect(first).toBeGreaterThan(0);
    await expect(p.init({ track: {} as MediaStreamTrack })).rejects.toThrow();
    expect(fetchMock.mock.calls.length).toBeGreaterThan(first);
  });

  it("destroy é idempotente e seguro sem init", async () => {
    const p = new RnnoiseTrackProcessor();
    await p.destroy();
    await p.destroy();
  });
});
