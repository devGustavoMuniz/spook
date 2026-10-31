import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MicTestState } from "./engine";
import { MIC_TEST_DURATION_MS, type MicPipeline, type MicTestDeps, MicTester } from "./mic-test";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "MediaStream",
    class {
      constructor(public tracks: unknown[] = []) {}
    },
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function setup(over: { startError?: Error } = {}) {
  const log: string[] = [];
  const recorder = {
    state: "inactive" as string,
    mimeType: "audio/webm",
    ondataavailable: null as null | ((e: { data: Blob }) => void),
    onstop: null as null | (() => void),
    start() {
      log.push("rec:start");
      this.state = "recording";
    },
    stop() {
      log.push("rec:stop");
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob(["x"]) });
      this.onstop?.();
    },
  };
  const audio = {
    sink: "" as string,
    paused: false,
    currentTime: 0,
    duration: 5,
    onended: null as null | (() => void),
    onerror: null as null | (() => void),
    async setSinkId(id: string) {
      this.sink = id;
      log.push(`sink:${id}`);
    },
    async play() {
      log.push("play");
    },
    pause() {
      this.paused = true;
    },
  };
  const pipeline = {
    async start() {
      log.push("pipeline:start");
      if (over.startError) throw over.startError;
      return {} as MediaStreamTrack;
    },
    stop() {
      log.push("pipeline:stop");
    },
    configure() {},
  };
  const deps: MicTestDeps = {
    createPipeline: () => pipeline as unknown as MicPipeline,
    createRecorder: () => recorder as unknown as MediaRecorder,
    createAudio: () => audio as never,
    createObjectUrl: () => "blob:x",
    revokeObjectUrl: (u) => log.push(`revoke:${u}`),
  };
  const states: MicTestState[] = [];
  const tester = new MicTester(deps);
  const opts = {
    constraints: {},
    strong: false,
    sensitivity: { mode: "off", thresholdDb: -50 } as const,
    onLevel: () => {},
    outputDeviceId: "spk1",
  };
  return { tester, states, log, audio, opts, emit: (s: MicTestState) => states.push(s) };
}

describe("MicTester: gravar e reproduzir", () => {
  it("pede o microfone, grava ~5 s com contagem regressiva, reproduz no alto-falante escolhido e termina", async () => {
    const { tester, states, log, audio, opts, emit } = setup();
    const done = tester.run(opts, emit);
    await vi.advanceTimersByTimeAsync(MIC_TEST_DURATION_MS + 200);
    expect(states[0]).toEqual({ phase: "requesting" });
    const rec = states.filter((s) => s.phase === "recording");
    expect(rec[0]?.remainingMs).toBe(MIC_TEST_DURATION_MS);
    expect(rec.at(-1)?.remainingMs).toBeLessThan(1000); // a contagem regressiva andou
    expect(log).toContain("sink:spk1");
    expect(states.some((s) => s.phase === "playing")).toBe(true);
    // a gravação termina; o teste só conclui quando a reprodução acaba
    audio.onended?.();
    await done;
    expect(states.at(-1)).toEqual({ phase: "done" });
    expect(log.indexOf("rec:stop")).toBeLessThan(log.indexOf("play")); // nunca reproduz ao vivo
    expect(log.indexOf("pipeline:stop")).toBeLessThan(log.indexOf("play")); // mic fechado antes de tocar
    expect(log).toContain("revoke:blob:x");
    expect(tester.running).toBe(false);
  });

  it("permissão negada vira erro 'permission-denied' (e o microfone não fica aberto)", async () => {
    const err = Object.assign(new Error("x"), { name: "NotAllowedError" });
    const { tester, states, log, opts, emit } = setup({ startError: err });
    await tester.run(opts, emit);
    expect(states.at(-1)).toEqual({ phase: "error", error: "permission-denied" });
    expect(log).toContain("pipeline:stop");
    expect(tester.running).toBe(false);
  });

  it("cancelar durante a gravação para tudo, não reproduz e conclui", async () => {
    const { tester, states, log, opts, emit } = setup();
    const done = tester.run(opts, emit);
    await vi.advanceTimersByTimeAsync(1500);
    tester.cancel();
    await vi.advanceTimersByTimeAsync(50);
    await done;
    expect(log).not.toContain("play");
    expect(states.at(-1)).toEqual({ phase: "done" });
    expect(tester.running).toBe(false);
  });

  it("um teste por vez", async () => {
    const { tester, states, log, opts, emit } = setup();
    const first = tester.run(opts, emit);
    await tester.run(opts, emit); // ignorado
    expect(log.filter((l) => l === "pipeline:start")).toHaveLength(1);
    tester.cancel();
    await vi.advanceTimersByTimeAsync(10);
    await first;
    expect(states.length).toBeGreaterThan(0);
  });
});
