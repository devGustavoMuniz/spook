import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FIRST_FRAME_TIMEOUT_MS,
  type FrameWatch,
  hasFrame,
  watchFirstFrame,
} from "./stream-health";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

/** `<video>` de mentira: o jsdom não decodifica, então as dimensões e o estado são definidos à mão. */
function videoIn(host: HTMLElement, size: { w: number; h: number; ready: number }) {
  const v = document.createElement("video");
  Object.defineProperty(v, "videoWidth", { value: size.w, configurable: true });
  Object.defineProperty(v, "videoHeight", { value: size.h, configurable: true });
  Object.defineProperty(v, "readyState", { value: size.ready, configurable: true });
  host.appendChild(v);
  return v;
}

describe("hasFrame", () => {
  it("vídeo só conta com dimensões e dados; canvas só depois do primeiro desenho", () => {
    const host = document.createElement("div");
    expect(hasFrame(host)).toBe(false);
    const v = videoIn(host, { w: 0, h: 0, ready: 0 });
    expect(hasFrame(host)).toBe(false);
    v.remove();
    videoIn(host, { w: 1920, h: 1080, ready: 1 }); // metadados, sem quadro ainda
    expect(hasFrame(host)).toBe(false);
    host.innerHTML = "";
    videoIn(host, { w: 1920, h: 1080, ready: 2 });
    expect(hasFrame(host)).toBe(true);
    host.innerHTML = "";
    const c = document.createElement("canvas");
    host.appendChild(c);
    expect(hasFrame(host)).toBe(false);
    c.dataset.frame = "1";
    expect(hasFrame(host)).toBe(true);
  });
});

describe("watchFirstFrame (relógio falso)", () => {
  it("espera, avisa o primeiro quadro com o tempo até ele e para de checar", () => {
    const host = document.createElement("div");
    const seen: FrameWatch[] = [];
    let now = 1_000;
    const stop = watchFirstFrame(host, (w) => seen.push(w), { now: () => now });
    expect(seen).toEqual([{ state: "waiting", firstFrameMs: null }]);
    now += 700;
    videoIn(host, { w: 1280, h: 720, ready: 2 });
    vi.advanceTimersByTime(200);
    expect(seen.at(-1)).toEqual({ state: "ready", firstFrameMs: 700 });
    const n = seen.length;
    now += 5_000;
    vi.advanceTimersByTime(1_000);
    expect(seen).toHaveLength(n); // pronto: não emite mais
    stop();
  });

  it("sem quadro até o prazo vira stalled; um quadro tardio ainda vira ready", () => {
    const host = document.createElement("div");
    const seen: FrameWatch["state"][] = [];
    let now = 0;
    watchFirstFrame(host, (w) => seen.push(w.state), { now: () => now });
    now = FIRST_FRAME_TIMEOUT_MS + 1;
    vi.advanceTimersByTime(200);
    expect(seen.at(-1)).toBe("stalled");
    now += 1_000;
    videoIn(host, { w: 640, h: 360, ready: 4 });
    vi.advanceTimersByTime(200);
    expect(seen.at(-1)).toBe("ready");
    expect(seen.filter((s) => s === "stalled")).toHaveLength(1);
  });

  it("parar cancela a checagem", () => {
    const host = document.createElement("div");
    const cb = vi.fn();
    const stop = watchFirstFrame(host, cb);
    stop();
    cb.mockClear();
    videoIn(host, { w: 640, h: 360, ready: 4 });
    vi.advanceTimersByTime(1_000);
    expect(cb).not.toHaveBeenCalled();
  });
});
