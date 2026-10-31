import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionIndicator, RECONNECT_NOTICE_DELAY_MS } from "./connection-indicator";
import { useGatewayStore } from "./store";

beforeEach(() => {
  vi.useFakeTimers();
  useGatewayStore.getState().reset();
});
afterEach(() => vi.useRealTimers());

const set = (fn: () => void) => act(fn);

describe("indicador de conexão", () => {
  it("não aparece conectado nem na conexão inicial", () => {
    render(<ConnectionIndicator />);
    set(() => useGatewayStore.getState().setStatus("connecting"));
    expect(screen.queryByText("Reconectando…")).toBeNull();
    set(() => useGatewayStore.getState().setStatus("connected"));
    expect(screen.queryByText("Reconectando…")).toBeNull();
  });

  it("quedas curtas não piscam: só avisa depois do atraso", () => {
    render(<ConnectionIndicator />);
    set(() => useGatewayStore.getState().setStatus("reconnecting"));
    act(() => vi.advanceTimersByTime(RECONNECT_NOTICE_DELAY_MS - 1));
    expect(screen.queryByText("Reconectando…")).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByText("Reconectando…")).toBeInTheDocument();
    set(() => useGatewayStore.getState().setStatus("connected"));
    expect(screen.queryByText("Reconectando…")).toBeNull();
  });

  it("queda curta que se resolve antes do atraso nunca mostra o aviso", () => {
    render(<ConnectionIndicator />);
    set(() => useGatewayStore.getState().setStatus("reconnecting"));
    act(() => vi.advanceTimersByTime(1_000));
    set(() => useGatewayStore.getState().setStatus("connected"));
    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.queryByText("Reconectando…")).toBeNull();
  });

  it("sessão aberta em outro lugar: avisa e oferece reconectar", () => {
    const retry = vi.fn();
    render(<ConnectionIndicator />);
    set(() => {
      const s = useGatewayStore.getState();
      s.setRetry(retry);
      s.setError({ kind: "taken_over", message: "x", code: 4002 });
      s.setStatus("closed");
    });
    act(() => screen.getByRole("button", { name: "Reconectar" }).click());
    expect(retry).toHaveBeenCalled();
  });
});
