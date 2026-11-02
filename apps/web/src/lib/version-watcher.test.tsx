import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentBuild } from "./version-check";
import {
  VERSION_CHECK_INTERVAL_MS,
  VERSION_FOCUS_THROTTLE_MS,
  VersionWatcher,
} from "./version-watcher";

let remote: { version: string; commit: string; builtAt: string } | null;
const fetchSpy = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  remote = { ...currentBuild() };
  fetchSpy.mockReset();
  fetchSpy.mockImplementation(async () =>
    remote ? Response.json(remote) : new Response("", { status: 404 }),
  );
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

describe("VersionWatcher", () => {
  it("não faz nada quando desligado (dev e desktop)", async () => {
    render(<VersionWatcher enabled={false} />);
    await tick(VERSION_CHECK_INTERVAL_MS * 2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("mesma versão: consulta a cada 10 min e não mostra nada", async () => {
    render(<VersionWatcher enabled />);
    await tick(VERSION_CHECK_INTERVAL_MS);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await tick(VERSION_CHECK_INTERVAL_MS);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/Nova versão disponível/)).not.toBeInTheDocument();
  });

  it("build novo no servidor: banner discreto com Recarregar, sem recarregar sozinho", async () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    render(<VersionWatcher enabled />);
    remote = { ...currentBuild(), commit: "fffffff" };
    await tick(VERSION_CHECK_INTERVAL_MS);
    expect(screen.getByText("Nova versão disponível.")).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Recarregar/ }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("dispensar esconde o banner", async () => {
    render(<VersionWatcher enabled />);
    remote = { ...currentBuild(), commit: "fffffff" };
    await tick(VERSION_CHECK_INTERVAL_MS);
    fireEvent.click(screen.getByRole("button", { name: "Dispensar aviso de nova versão" }));
    expect(screen.queryByText("Nova versão disponível.")).not.toBeInTheDocument();
  });

  it("ao voltar o foco consulta, mas não mais de uma vez a cada 30 s", async () => {
    render(<VersionWatcher enabled />);
    await tick(VERSION_FOCUS_THROTTLE_MS);
    fireEvent(window, new Event("focus"));
    await tick(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fireEvent(window, new Event("focus"));
    await tick(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await tick(VERSION_FOCUS_THROTTLE_MS);
    fireEvent(window, new Event("focus"));
    await tick(0);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("falha de rede ou 404 não mostra aviso", async () => {
    remote = null;
    render(<VersionWatcher enabled />);
    await tick(VERSION_CHECK_INTERVAL_MS);
    expect(screen.queryByText(/Nova versão/)).not.toBeInTheDocument();
  });
});
