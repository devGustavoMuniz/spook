import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeVoiceEngine } from "@/test/fake-voice-engine";
import { resetVoiceController } from "./controller";
import { saveDevicePref, saveScreenSharePrefs } from "./devices";
import { setVoiceEngineFactory } from "./engine-provider";
import { saveScreenQuality } from "./screen-quality";
import { ScreenShareDialog } from "./screen-share-dialog";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

beforeEach(() => {
  localStorage.clear();
  setVoiceEngineFactory(() => new FakeVoiceEngine());
});
afterEach(() => {
  setVoiceEngineFactory(null);
  resetVoiceController();
});

describe("ScreenShareDialog", () => {
  it("o áudio começa desligado e a orientação sobre eco/aba/fones aparece", async () => {
    render(<ScreenShareDialog open onOpenChange={() => {}} onConfirm={() => {}} />);
    expect(await screen.findByRole("switch", { name: /Incluir áudio/ })).not.toBeChecked();
    expect(screen.getByText(/ouvirão de volta \(eco\)/)).toBeInTheDocument();
    expect(screen.getByText(/compartilhe uma/)).toHaveTextContent(/aba/);
    expect(screen.getByText(/use fones de ouvido/)).toBeInTheDocument();
  });

  it("confirma sem áudio por padrão", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<ScreenShareDialog open onOpenChange={() => {}} onConfirm={onConfirm} />);
    await user.click(await screen.findByRole("button", { name: "Compartilhar" }));
    expect(onConfirm).toHaveBeenCalledWith({ audio: false });
  });

  it("incluir áudio é uma escolha explícita", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<ScreenShareDialog open onOpenChange={() => {}} onConfirm={onConfirm} />);
    await user.click(await screen.findByRole("switch", { name: /Incluir áudio/ }));
    await user.click(screen.getByRole("button", { name: "Compartilhar" }));
    expect(onConfirm).toHaveBeenCalledWith({ audio: true });
  });

  it("lembra a última escolha", async () => {
    saveScreenSharePrefs({ audio: true });
    render(<ScreenShareDialog open onOpenChange={() => {}} onConfirm={() => {}} />);
    expect(await screen.findByRole("switch", { name: /Incluir áudio/ })).toBeChecked();
  });

  it("áudio ligado com saída que parece caixa de som: aviso extra de eco", async () => {
    const user = userEvent.setup();
    const eng = new FakeVoiceEngine();
    eng.devices.audiooutput = [{ id: "spk", label: "Alto-falantes (Realtek)" }];
    setVoiceEngineFactory(() => eng);
    saveDevicePref("audiooutput", "spk");
    render(<ScreenShareDialog open onOpenChange={() => {}} onConfirm={() => {}} />);
    const toggle = await screen.findByRole("switch", { name: /Incluir áudio/ });
    expect(screen.queryByRole("status")).toBeNull();
    await user.click(toggle);
    expect(await screen.findByRole("status")).toHaveTextContent(/caixa de som/);
  });

  it("com fones (ou saída desconhecida) não mostra o aviso extra", async () => {
    const eng = new FakeVoiceEngine();
    eng.devices.audiooutput = [{ id: "fone", label: "Fones de ouvido Bluetooth" }];
    setVoiceEngineFactory(() => eng);
    saveDevicePref("audiooutput", "fone");
    saveScreenSharePrefs({ audio: true });
    render(<ScreenShareDialog open onOpenChange={() => {}} onConfirm={() => {}} />);
    await screen.findByRole("switch", { name: /Incluir áudio/ });
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  it("no app de computador não há opção de áudio: explica que só a imagem vai e confirma sem áudio", async () => {
    const user = userEvent.setup();
    const eng = new FakeVoiceEngine();
    eng.audioCapabilities = { strongNoiseSuppression: true, screenShareAudio: false };
    setVoiceEngineFactory(() => eng);
    saveScreenSharePrefs({ audio: true });
    const onConfirm = vi.fn();
    render(<ScreenShareDialog open onOpenChange={() => {}} onConfirm={onConfirm} />);
    expect(await screen.findByText(/só a imagem/)).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: /Incluir áudio/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Compartilhar" }));
    expect(onConfirm).toHaveBeenCalledWith({ audio: false });
  });
});

describe("ScreenShareDialog: qualidade", () => {
  function withQuality() {
    const eng = new FakeVoiceEngine();
    eng.audioCapabilities = { strongNoiseSuppression: false, screenShareQuality: true };
    setVoiceEngineFactory(() => eng);
  }

  it("engine sem a capacidade (desktop por enquanto): sem controles e explica com honestidade", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<ScreenShareDialog open onOpenChange={() => {}} onConfirm={onConfirm} />);
    expect(await screen.findByText(/qualidade da imagem é automática/)).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Qualidade" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Compartilhar" }));
    expect(onConfirm).toHaveBeenCalledWith({ audio: false }); // sem `quality`
  });

  it("lista os presets nomeados; o padrão é Nitidez 1080p 15 fps e não mostra aviso de custo", async () => {
    withQuality();
    render(<ScreenShareDialog open onOpenChange={() => {}} onConfirm={() => {}} />);
    const group = await screen.findByRole("group", { name: "Qualidade" });
    const radios = within(group).getAllByRole("radio", { name: /—/ });
    expect(radios.map((r) => r.getAttribute("id"))).toEqual([
      "screen-quality-sharp",
      "screen-quality-balanced",
      "screen-quality-smooth",
      "screen-quality-high",
    ]);
    expect(await screen.findByRole("radio", { name: /^Nitidez — 1080p 15 fps/ })).toBeChecked();
    expect(screen.getByText(/Banda de subida estimada: até 2,5 Mbps/)).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("escolher um preset maior mostra a estimativa nova e o aviso de CPU/banda; confirmar manda e persiste", async () => {
    withQuality();
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<ScreenShareDialog open onOpenChange={() => {}} onConfirm={onConfirm} />);
    await user.click(await screen.findByRole("radio", { name: /^Alta — 1440p 30 fps/ }));
    expect(screen.getByText(/até 7 Mbps/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      /processador e internet de quem transmite/,
    );
    await user.click(screen.getByRole("button", { name: "Compartilhar" }));
    expect(onConfirm).toHaveBeenCalledWith({
      audio: false,
      quality: { height: 1440, fps: 30, priority: "detail" },
    });
  });

  it("opções avançadas: resolução, fps e prioridade; vira 'personalizada' e a estimativa acompanha", async () => {
    withQuality();
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<ScreenShareDialog open onOpenChange={() => {}} onConfirm={onConfirm} />);
    await user.click(await screen.findByText(/Opções avançadas/));
    await user.selectOptions(screen.getByLabelText("Resolução"), "720");
    await user.selectOptions(screen.getByLabelText("Quadros por segundo"), "60");
    await user.click(screen.getByRole("radio", { name: /Priorizar fluidez/ }));
    expect(screen.getByText(/\(personalizada\)|Opções avançadas/)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /^Fluidez — 720p 60 fps/ })).toBeChecked(); // coincide com o preset
    expect(screen.getByText(/até 3,5 Mbps/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Compartilhar" }));
    expect(onConfirm).toHaveBeenCalledWith({
      audio: false,
      quality: { height: 720, fps: 60, priority: "motion" },
    });
  });

  it("lembra a última qualidade escolhida", async () => {
    withQuality();
    saveScreenQuality({ height: 1080, fps: 30, priority: "motion" });
    render(<ScreenShareDialog open onOpenChange={() => {}} onConfirm={() => {}} />);
    expect(await screen.findByRole("radio", { name: /^Equilibrado/ })).toBeChecked();
  });

  it("os presets se operam pelo teclado (setas) e cada um tem descrição", async () => {
    withQuality();
    const user = userEvent.setup();
    render(<ScreenShareDialog open onOpenChange={() => {}} onConfirm={() => {}} />);
    const sharp = await screen.findByRole("radio", { name: /^Nitidez/ });
    expect(sharp).toHaveAccessibleDescription(/Texto, código e apresentações/);
    sharp.focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("radio", { name: /^Equilibrado/ })).toBeChecked();
  });
});
