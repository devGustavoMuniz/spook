import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDLE_AFTER_MS, IdleDetector, watchIdle } from "./idle-detector";

const MIN = 60_000;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("IdleDetector", () => {
  it("o prazo padrão é de 10 minutos (SPEC 7.6)", () => {
    expect(IDLE_AFTER_MS).toBe(10 * MIN);
  });

  it("fica ausente depois de 10 min sem interação e volta a online ao interagir", () => {
    const changes: string[] = [];
    const d = new IdleDetector({ onChange: (s) => changes.push(s) });
    d.start();
    vi.advanceTimersByTime(10 * MIN - 1);
    expect(changes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(changes).toEqual(["idle"]);
    expect(d.status).toBe("idle");

    d.activity();
    expect(changes).toEqual(["idle", "online"]);
    // e o ciclo recomeça: 10 min depois fica ausente de novo
    vi.advanceTimersByTime(10 * MIN);
    expect(changes).toEqual(["idle", "online", "idle"]);
  });

  it("interações adiam o prazo sem avisar nada (um único timer reagendado)", () => {
    const changes: string[] = [];
    const d = new IdleDetector({ onChange: (s) => changes.push(s) });
    d.start();
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(4 * MIN);
      d.activity(); // a cada 4 min: nunca completa 10 min parado
    }
    expect(changes).toEqual([]);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(10 * MIN);
    expect(changes).toEqual(["idle"]);
  });

  it("stop cancela o timer", () => {
    const changes: string[] = [];
    const d = new IdleDetector({ onChange: (s) => changes.push(s) });
    d.start();
    d.stop();
    vi.advanceTimersByTime(60 * MIN);
    expect(changes).toEqual([]);
  });
});

describe("watchIdle (eventos do navegador)", () => {
  it("mouse, teclado, toque e a aba voltando a ficar visível contam como interação", () => {
    const changes: string[] = [];
    const stop = watchIdle((s) => changes.push(s), { timeoutMs: MIN });
    const goIdle = () => vi.advanceTimersByTime(MIN);

    goIdle();
    window.dispatchEvent(new Event("mousemove"));
    goIdle();
    window.dispatchEvent(new Event("keydown"));
    goIdle();
    window.dispatchEvent(new Event("touchstart"));
    goIdle();
    document.dispatchEvent(new Event("visibilitychange")); // jsdom: visibilityState = "visible"
    expect(changes).toEqual([
      "idle",
      "online",
      "idle",
      "online",
      "idle",
      "online",
      "idle",
      "online",
    ]);

    stop();
    window.dispatchEvent(new Event("mousemove"));
    goIdle();
    expect(changes).toHaveLength(8); // depois do stop nada mais é sinalizado
  });
});
