import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { type IdleClock, useIdleControls } from "./use-idle-controls";

/** Relógio falso manual: o teste decide quando o tempo passa. */
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: IdleClock = {
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id) => void timers.delete(id as number),
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [id, t] of [...timers]) {
      if (t.at <= now) {
        timers.delete(id);
        t.fn();
      }
    }
  };
  return { clock, advance, pending: () => timers.size };
}

const mouse = { pointerType: "mouse" } as React.PointerEvent;

describe("useIdleControls", () => {
  it("some após 3 s parado e volta com o mouse", () => {
    const c = fakeClock();
    const { result } = renderHook(() => useIdleControls({ clock: c.clock }));
    expect(result.current.visible).toBe(true);
    act(() => c.advance(2900));
    expect(result.current.visible).toBe(true);
    act(() => c.advance(200));
    expect(result.current.visible).toBe(false);
    act(() => result.current.stageProps.onPointerMove(mouse));
    expect(result.current.visible).toBe(true);
    act(() => c.advance(3100));
    expect(result.current.visible).toBe(false);
  });

  it("movimento reinicia a contagem", () => {
    const c = fakeClock();
    const { result } = renderHook(() => useIdleControls({ clock: c.clock }));
    act(() => c.advance(2500));
    act(() => result.current.stageProps.onPointerMove(mouse));
    act(() => c.advance(2500));
    expect(result.current.visible).toBe(true);
    act(() => c.advance(600));
    expect(result.current.visible).toBe(false);
  });

  it("tecla acorda", () => {
    const c = fakeClock();
    const { result } = renderHook(() => useIdleControls({ clock: c.clock }));
    act(() => c.advance(3100));
    expect(result.current.visible).toBe(false);
    act(() => result.current.stageProps.onKeyDownCapture());
    expect(result.current.visible).toBe(true);
  });

  it("mouse sobre os controles ou um menu aberto seguram a visibilidade", () => {
    const c = fakeClock();
    const { result } = renderHook(() => useIdleControls({ clock: c.clock }));
    act(() => result.current.barProps.onPointerEnter(mouse));
    act(() => c.advance(10_000));
    expect(result.current.visible).toBe(true);
    act(() => result.current.barProps.onPointerLeave());
    act(() => result.current.hold(true));
    act(() => c.advance(10_000));
    expect(result.current.visible).toBe(true);
    act(() => result.current.hold(false));
    act(() => c.advance(3100));
    expect(result.current.visible).toBe(false);
  });

  it("desabilitado, fica sempre visível e sem temporizador; ao habilitar, conta de novo", () => {
    const c = fakeClock();
    const { result, rerender } = renderHook(
      ({ enabled }) => useIdleControls({ clock: c.clock, enabled }),
      { initialProps: { enabled: false } },
    );
    expect(c.pending()).toBe(0);
    act(() => c.advance(10_000));
    expect(result.current.visible).toBe(true);
    rerender({ enabled: true });
    expect(c.pending()).toBe(1);
    act(() => c.advance(3100));
    expect(result.current.visible).toBe(false);
    rerender({ enabled: false });
    expect(result.current.visible).toBe(true);
  });

  it("forceVisible mantém visível mesmo depois do prazo", () => {
    const c = fakeClock();
    const { result } = renderHook(() => useIdleControls({ clock: c.clock, forceVisible: true }));
    act(() => c.advance(10_000));
    expect(result.current.visible).toBe(true);
  });
});
