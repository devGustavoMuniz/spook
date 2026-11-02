import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { FakeVoiceEngine } from "@/test/fake-voice-engine";
import { makeBackend, server } from "@/test/server";
import { joinVoice, resetVoiceController } from "./controller";
import { setVoiceEngineFactory } from "./engine-provider";
import { NetworkIndicator, rateNetwork, statsText } from "./network-indicator";
import { useVoiceStore } from "./store";

describe("nota de rede", () => {
  const ok = { rttMs: 40, lossPct: 0, jitterMs: 5 };
  it("limiares de bom, médio e ruim por métrica; vale o pior", () => {
    expect(rateNetwork(ok, "excellent")).toBe("good");
    expect(rateNetwork({ ...ok, rttMs: 100 }, "good")).toBe("good");
    expect(rateNetwork({ ...ok, rttMs: 101 }, "good")).toBe("medium");
    expect(rateNetwork({ ...ok, rttMs: 251 }, "good")).toBe("bad");
    expect(rateNetwork({ ...ok, lossPct: 2 }, "good")).toBe("good");
    expect(rateNetwork({ ...ok, lossPct: 3 }, "good")).toBe("medium");
    expect(rateNetwork({ ...ok, lossPct: 6 }, "good")).toBe("bad");
    expect(rateNetwork({ ...ok, jitterMs: 31 }, "good")).toBe("medium");
    expect(rateNetwork({ ...ok, jitterMs: 61 }, "good")).toBe("bad");
    expect(rateNetwork({ rttMs: 40, lossPct: 7, jitterMs: 100 }, "good")).toBe("bad");
  });

  it("valores sem medição não pioram a nota", () => {
    expect(rateNetwork({ rttMs: null, lossPct: null, jitterMs: 4 }, "good")).toBe("good");
    expect(rateNetwork({ rttMs: null, lossPct: null, jitterMs: null }, "unknown")).toBe("unknown");
  });

  it("sem números cai na qualidade do enlace; a qualidade ruim também rebaixa", () => {
    expect(rateNetwork(null, "excellent")).toBe("good");
    expect(rateNetwork(null, "poor")).toBe("medium");
    expect(rateNetwork(null, "lost")).toBe("bad");
    expect(rateNetwork(null, "unknown")).toBe("unknown");
    expect(rateNetwork(ok, "poor")).toBe("medium");
    expect(rateNetwork(ok, "lost")).toBe("bad");
  });

  it("texto com os números em pt-br", () => {
    expect(statsText({ rttMs: 42, lossPct: 0.5, jitterMs: null })).toBe(
      "Latência 42 ms · Perda 0,5 % · Jitter sem medição",
    );
    expect(statsText(null)).toMatch(/Sem números/);
  });
});

describe("indicador", () => {
  let fake: FakeVoiceEngine;
  beforeEach(() => {
    fake = new FakeVoiceEngine();
    setVoiceEngineFactory(() => fake);
    resetVoiceController();
    server.use(...makeBackend({ signedIn: true }).handlers);
  });
  afterEach(() => {
    setVoiceEngineFactory(null);
    resetVoiceController();
    vi.useRealTimers();
  });

  const mount = () =>
    render(
      <TooltipProvider>
        <NetworkIndicator quality="good" />
      </TooltipProvider>,
    );

  it("sem números usa o nome da qualidade do enlace", () => {
    useVoiceStore.setState({ status: "idle" });
    mount();
    expect(screen.getByRole("img", { name: "Conexão boa" })).toHaveAttribute("data-rating", "good");
  });

  it("conectado, mede e mostra latência, perda e jitter (nome acessível e tooltip)", async () => {
    const user = userEvent.setup();
    fake.stats = { rttMs: 180, lossPct: 3.5, jitterMs: 12 };
    await joinVoice({ channelId: "c1", guildId: "g1", channelName: "Geral", canSpeak: false });
    mount();
    const img = await screen.findByRole("img", { name: /Conexão instável.*Latência 180 ms/ });
    expect(img).toHaveAttribute("data-rating", "medium");
    expect(img.getAttribute("aria-label")).toContain("Perda 3,5 %");
    expect(img.getAttribute("aria-label")).toContain("Jitter 12 ms");
    await user.hover(img);
    expect((await screen.findAllByText(/Latência 180 ms/)).length).toBeGreaterThan(0);
  });

  it("atualiza a cada 3 s", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fake.stats = { rttMs: 20, lossPct: 0, jitterMs: 2 };
    await joinVoice({ channelId: "c1", guildId: "g1", channelName: "Geral", canSpeak: false });
    mount();
    await screen.findByRole("img", { name: /Conexão boa.*Latência 20 ms/ });
    fake.stats = { rttMs: 400, lossPct: 0, jitterMs: 2 };
    await act(async () => void vi.advanceTimersByTime(3100));
    expect(
      await screen.findByRole("img", { name: /Conexão ruim.*Latência 400 ms/ }),
    ).toBeInTheDocument();
  });
});
