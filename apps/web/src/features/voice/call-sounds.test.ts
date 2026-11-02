import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePresenceStore } from "@/features/presence/store";
import {
  DEFAULT_CALL_SOUNDS,
  loadCallSoundPrefs,
  noteUserGesture,
  playCallSound,
  RECIPES,
  resetCallSounds,
  saveCallSoundPrefs,
  soundLength,
  startRing,
  stopRing,
} from "./call-sounds";

const made = vi.hoisted(() => ({ ctxs: 0, oscs: [] as { f: number }[], resumed: 0 }));

class StubParam {
  value = 0;
  setValueAtTime() {}
  linearRampToValueAtTime() {}
  exponentialRampToValueAtTime() {}
}
class StubContext {
  state = "suspended";
  currentTime = 0;
  destination = {};
  constructor() {
    made.ctxs++;
  }
  resume() {
    made.resumed++;
    return Promise.resolve();
  }
  createGain() {
    return { gain: new StubParam(), connect() {} };
  }
  createOscillator() {
    const o = {
      type: "sine",
      frequency: new StubParam(),
      connect() {},
      start() {},
      stop() {},
      f: 0,
    };
    made.oscs.push(o);
    return o;
  }
}

beforeEach(() => {
  localStorage.clear();
  made.ctxs = 0;
  made.oscs = [];
  made.resumed = 0;
  vi.stubGlobal("AudioContext", StubContext);
  (window as unknown as { AudioContext: unknown }).AudioContext = StubContext;
  resetCallSounds();
  usePresenceStore.getState().setMine(null, { status_pref: "online" });
});
afterEach(() => {
  vi.unstubAllGlobals();
  stopRing();
});

describe("sons de chamada", () => {
  it("não cria AudioContext antes de um gesto do usuário", () => {
    expect(playCallSound("join")).toBe(false);
    expect(made.ctxs).toBe(0);
  });

  it("depois do gesto cria o contexto uma vez e toca uma nota por oscilador da receita", () => {
    noteUserGesture();
    expect(playCallSound("join")).toBe(true);
    expect(playCallSound("leave")).toBe(true);
    expect(made.ctxs).toBe(1);
    expect(made.resumed).toBeGreaterThan(0);
    expect(made.oscs).toHaveLength(RECIPES.join.length + RECIPES.leave.length);
  });

  it("um clique real conta como gesto", () => {
    window.dispatchEvent(new Event("pointerdown"));
    expect(playCallSound("mute")).toBe(true);
  });

  it("não toca em Não perturbar", () => {
    noteUserGesture();
    usePresenceStore.getState().setMine(null, { status_pref: "dnd" });
    expect(playCallSound("join")).toBe(false);
    expect(made.oscs).toHaveLength(0);
  });

  it("respeita o interruptor do grupo e o volume zero", () => {
    noteUserGesture();
    saveCallSoundPrefs({
      ...DEFAULT_CALL_SOUNDS,
      groups: { ...DEFAULT_CALL_SOUNDS.groups, peers: false },
    });
    expect(playCallSound("peer-join")).toBe(false);
    expect(playCallSound("join")).toBe(true);
    saveCallSoundPrefs({ ...DEFAULT_CALL_SOUNDS, volume: 0 });
    expect(playCallSound("join")).toBe(false);
  });

  it("sem AudioContext no navegador não quebra", () => {
    (window as unknown as { AudioContext?: unknown }).AudioContext = undefined;
    noteUserGesture();
    expect(playCallSound("join")).toBe(false);
  });

  it("preferências inválidas voltam ao padrão e o volume é limitado", () => {
    localStorage.setItem("spook:call-sounds", JSON.stringify({ volume: 9, groups: { self: "x" } }));
    const p = loadCallSoundPrefs();
    expect(p.volume).toBe(1);
    expect(p.groups.self).toBe(true);
    localStorage.setItem("spook:call-sounds", "{quebrado");
    expect(loadCallSoundPrefs()).toEqual(DEFAULT_CALL_SOUNDS);
  });

  it("o toque de chamada repete até parar", () => {
    vi.useFakeTimers();
    noteUserGesture();
    startRing();
    const first = made.oscs.length;
    expect(first).toBe(RECIPES.ring.length);
    vi.advanceTimersByTime(5100);
    expect(made.oscs.length).toBe(first * 3);
    stopRing();
    vi.advanceTimersByTime(5000);
    expect(made.oscs.length).toBe(first * 3);
    vi.useRealTimers();
  });

  it("todas as receitas têm duração curta", () => {
    for (const k of Object.keys(RECIPES) as (keyof typeof RECIPES)[])
      expect(soundLength(k)).toBeLessThan(1.2);
  });
});
