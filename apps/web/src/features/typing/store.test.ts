import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TYPING_TTL_MS, typingText, useTypingStore } from "./store";
import { createTypingThrottle } from "./throttle";

const users = (ch: string) => useTypingStore.getState().byChannel[ch] ?? [];

beforeEach(() => {
  vi.useFakeTimers();
  useTypingStore.getState().reset();
});
afterEach(() => vi.useRealTimers());

describe("store de 'digitando…'", () => {
  it("expira 8 s depois do último evento", () => {
    expect(TYPING_TTL_MS).toBe(8000);
    useTypingStore.getState().start("c1", "u1");
    vi.advanceTimersByTime(7999);
    expect(users("c1")).toEqual(["u1"]);
    vi.advanceTimersByTime(1);
    expect(users("c1")).toEqual([]);
  });

  it("um novo evento reinicia os 8 s (e não duplica a pessoa)", () => {
    const s = useTypingStore.getState();
    s.start("c1", "u1");
    vi.advanceTimersByTime(5000);
    s.start("c1", "u1");
    vi.advanceTimersByTime(5000); // 10 s desde o primeiro, 5 s desde o segundo
    expect(users("c1")).toEqual(["u1"]);
    vi.advanceTimersByTime(3000);
    expect(users("c1")).toEqual([]);
  });

  it("é por canal e por pessoa, na ordem em que começaram", () => {
    const s = useTypingStore.getState();
    s.start("c1", "u1");
    vi.advanceTimersByTime(3000);
    s.start("c1", "u2");
    s.start("c2", "u3");
    expect(users("c1")).toEqual(["u1", "u2"]);
    vi.advanceTimersByTime(5000); // u1 expira (8 s), u2 ainda não (5 s)
    expect(users("c1")).toEqual(["u2"]);
    expect(users("c2")).toEqual(["u3"]);
  });

  it("stop (mensagem enviada) tira a pessoa na hora e cancela o timer", () => {
    const s = useTypingStore.getState();
    s.start("c1", "u1");
    s.stop("c1", "u1");
    expect(users("c1")).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reset limpa tudo", () => {
    const s = useTypingStore.getState();
    s.start("c1", "u1");
    s.start("c2", "u2");
    s.reset();
    expect(useTypingStore.getState().byChannel).toEqual({});
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("typingText", () => {
  it("1, 2 ou várias pessoas", () => {
    expect(typingText([])).toBeNull();
    expect(typingText(["Fulano"])).toBe("Fulano está digitando…");
    expect(typingText(["Fulano", "Ciclano"])).toBe("Fulano e Ciclano estão digitando…");
    expect(typingText(["A", "B", "C"])).toBe("Várias pessoas estão digitando…");
  });
});

describe("throttle do aviso", () => {
  it("avisa na primeira tecla e depois só a cada 3 s; texto vazio nunca avisa", () => {
    let t = 1_000_000;
    const th = createTypingThrottle(() => t);
    expect(th.shouldSend("")).toBe(false);
    expect(th.shouldSend("   ")).toBe(false);
    expect(th.shouldSend("o")).toBe(true);
    t += 2999;
    expect(th.shouldSend("oi")).toBe(false);
    t += 1;
    expect(th.shouldSend("oi!")).toBe(true);
    // apagar tudo não conta nem consome o intervalo
    t += 3000;
    expect(th.shouldSend("")).toBe(false);
    expect(th.shouldSend("a")).toBe(true);
  });

  it("reset (mensagem enviada) libera o próximo aviso na hora", () => {
    const t = 0;
    const th = createTypingThrottle(() => t);
    expect(th.shouldSend("a")).toBe(true);
    th.reset();
    expect(th.shouldSend("b")).toBe(true);
  });
});
