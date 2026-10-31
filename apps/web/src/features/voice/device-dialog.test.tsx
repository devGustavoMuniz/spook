import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeVoiceEngine } from "@/test/fake-voice-engine";
import { resetVoiceController } from "./controller";
import { DeviceDialog, noiseStatusText } from "./device-dialog";
import {
  DEFAULT_AUDIO_PROCESSING,
  loadAudioProcessing,
  parseInputSensitivity,
  parseNoiseSuppression,
  saveAudioProcessing,
} from "./devices";
import type { AudioCapabilities, AudioProcessingOptions } from "./engine";
import { setVoiceEngineFactory } from "./engine-provider";
import { useAudioStatusStore, useInputLevelStore, useMicTestStore } from "./store";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

class ProcessingEngine extends FakeVoiceEngine {
  applied: AudioProcessingOptions[] = [];
  audioCapabilities: AudioCapabilities = { strongNoiseSuppression: true };
  async setAudioProcessing(o: AudioProcessingOptions) {
    this.applied.push(o);
  }
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  setVoiceEngineFactory(null);
  resetVoiceController();
  vi.restoreAllMocks();
});

const radio = (name: RegExp) => screen.findByRole("radio", { name });

describe("DeviceDialog: qualidade do microfone", () => {
  it("mostra os 3 níveis de ruído (Padrão marcado) e os interruptores de eco e ganho", async () => {
    setVoiceEngineFactory(() => new ProcessingEngine());
    render(<DeviceDialog open onOpenChange={() => {}} />);
    const group = await screen.findByRole("group", { name: "Redução de ruído" });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((r) => r.getAttribute("value"))).toEqual(["off", "standard", "strong"]);
    expect(await radio(/^Padrão/)).toBeChecked();
    for (const name of ["Cancelamento de eco", "Ajuste automático de volume"])
      expect(await screen.findByRole("switch", { name: new RegExp(name) })).toBeChecked();
    expect(loadAudioProcessing()).toEqual(DEFAULT_AUDIO_PROCESSING);
  });

  it("cada opção tem descrição ligada ao rádio (leitor de tela)", async () => {
    setVoiceEngineFactory(() => new ProcessingEngine());
    render(<DeviceDialog open onOpenChange={() => {}} />);
    expect(await radio(/^Forte/)).toHaveAccessibleDescription(/Usa mais processador/);
    expect(await radio(/^Desligada/)).toHaveAccessibleDescription(/sem filtro/);
  });

  it("escolher um nível aplica na engine e persiste", async () => {
    const user = userEvent.setup();
    const eng = new ProcessingEngine();
    setVoiceEngineFactory(() => eng);
    render(<DeviceDialog open onOpenChange={() => {}} />);
    await user.click(await radio(/^Forte/));
    await waitFor(() => expect(loadAudioProcessing().noiseSuppression).toBe("strong"));
    expect(eng.applied.at(-1)).toMatchObject({ noiseSuppression: "strong" });
    expect(await radio(/^Forte/)).toBeChecked();
    await user.click(await radio(/^Desligada/));
    await waitFor(() => expect(loadAudioProcessing().noiseSuppression).toBe("off"));
  });

  it("o seletor se opera pelo teclado (setas trocam o nível)", async () => {
    const user = userEvent.setup();
    setVoiceEngineFactory(() => new ProcessingEngine());
    render(<DeviceDialog open onOpenChange={() => {}} />);
    (await radio(/^Padrão/)).focus();
    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(loadAudioProcessing().noiseSuppression).toBe("strong"));
    await user.keyboard("{ArrowUp}{ArrowUp}");
    await waitFor(() => expect(loadAudioProcessing().noiseSuppression).toBe("off"));
  });

  it("desligar o eco persiste e não mexe no nível de ruído", async () => {
    const user = userEvent.setup();
    setVoiceEngineFactory(() => new ProcessingEngine());
    saveAudioProcessing({ ...DEFAULT_AUDIO_PROCESSING, noiseSuppression: "strong" });
    render(<DeviceDialog open onOpenChange={() => {}} />);
    await user.click(await screen.findByRole("switch", { name: /Cancelamento de eco/ }));
    await waitFor(() => expect(loadAudioProcessing().echoCancellation).toBe(false));
    expect(loadAudioProcessing().noiseSuppression).toBe("strong");
    expect(screen.getByRole("switch", { name: /Cancelamento de eco/ })).not.toBeChecked();
  });

  it("sem suporte ao Forte: a opção fica desabilitada com o motivo dado pela engine", async () => {
    const eng = new ProcessingEngine();
    eng.audioCapabilities = {
      strongNoiseSuppression: false,
      strongUnavailableReason: "em breve no app",
    };
    setVoiceEngineFactory(() => eng);
    render(<DeviceDialog open onOpenChange={() => {}} />);
    const strong = await radio(/^Forte/);
    expect(strong).toBeDisabled();
    expect(strong.closest("label")).toHaveTextContent("Forte (IA) (em breve no app)");
    expect(await radio(/^Padrão/)).toBeEnabled();
  });

  it("engine sem processamento de áudio: a seção não aparece", async () => {
    setVoiceEngineFactory(() => new FakeVoiceEngine());
    render(<DeviceDialog open onOpenChange={() => {}} />);
    await screen.findByText("Dispositivos de áudio e vídeo");
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("IA rebaixada: a seleção volta para Padrão e o motivo aparece", async () => {
    setVoiceEngineFactory(() => new ProcessingEngine());
    saveAudioProcessing({ ...DEFAULT_AUDIO_PROCESSING, noiseSuppression: "strong" });
    render(<DeviceDialog open onOpenChange={() => {}} />);
    expect(await radio(/^Forte/)).toBeChecked();
    act(() =>
      useAudioStatusStore.getState().set({
        level: "standard",
        state: "degraded",
        reason: "Falhou o download do modelo.",
      }),
    );
    await waitFor(async () => expect(await radio(/^Padrão/)).toBeChecked());
    expect(screen.getByText("Falhou o download do modelo.")).toBeInTheDocument();
  });

  it("o estado em efeito é anunciado numa região aria-live", async () => {
    setVoiceEngineFactory(() => new ProcessingEngine());
    saveAudioProcessing({ ...DEFAULT_AUDIO_PROCESSING, noiseSuppression: "strong" });
    render(<DeviceDialog open onOpenChange={() => {}} />);
    const live = (await screen.findByText(/A IA liga quando o microfone/)).closest("[aria-live]");
    expect(live).toHaveAttribute("aria-live", "polite");
    act(() => useAudioStatusStore.getState().set({ level: "strong", state: "active", load: "ok" }));
    expect(await screen.findByText("Processando com IA.")).toBeInTheDocument();
  });
});

describe("noiseStatusText", () => {
  it("descreve o que está ativo em cada nível e estado", () => {
    expect(noiseStatusText("off", null)).toMatch(/^Desligada/);
    expect(noiseStatusText("standard", null)).toMatch(/^Padrão do navegador/);
    expect(noiseStatusText("strong", { level: "strong", state: "loading" })).toMatch(/Carregando/);
    expect(noiseStatusText("strong", { level: "strong", state: "active", load: "ok" })).toBe(
      "Processando com IA.",
    );
    expect(noiseStatusText("strong", { level: "strong", state: "active", load: "high" })).toMatch(
      /no limite/,
    );
    expect(noiseStatusText("strong", { level: "standard", state: "degraded" })).toMatch(/Padrão/);
  });
});

describe("persistência e migração do valor antigo", () => {
  it("o formato antigo (booleano) migra: true -> Padrão, false -> Desligada", () => {
    expect(parseNoiseSuppression(true)).toBe("standard");
    expect(parseNoiseSuppression(false)).toBe("off");
    expect(parseNoiseSuppression("strong")).toBe("strong");
    expect(parseNoiseSuppression("turbo")).toBeUndefined();
    expect(parseNoiseSuppression(undefined)).toBeUndefined();

    localStorage.setItem(
      "spook:voice-audio-processing",
      '{"echoCancellation":false,"noiseSuppression":false,"autoGainControl":true}',
    );
    expect(loadAudioProcessing()).toEqual({
      echoCancellation: false,
      noiseSuppression: "off",
      autoGainControl: true,
      inputSensitivity: { mode: "off", thresholdDb: -50 }, // formato antigo não tinha porta de ruído
    });
    // a migração regrava no formato novo
    expect(JSON.parse(localStorage.getItem("spook:voice-audio-processing") ?? "{}")).toMatchObject({
      noiseSuppression: "off",
    });

    localStorage.setItem(
      "spook:voice-audio-processing",
      '{"echoCancellation":true,"noiseSuppression":true,"autoGainControl":true}',
    );
    expect(loadAudioProcessing().noiseSuppression).toBe("standard");
  });

  it("valores salvos inválidos voltam ao padrão", () => {
    localStorage.setItem(
      "spook:voice-audio-processing",
      '{"echoCancellation":"não","noiseSuppression":"turbo","autoGainControl":false}',
    );
    expect(loadAudioProcessing()).toEqual({ ...DEFAULT_AUDIO_PROCESSING, autoGainControl: false });
    localStorage.setItem("spook:voice-audio-processing", "lixo");
    expect(loadAudioProcessing()).toEqual(DEFAULT_AUDIO_PROCESSING);
  });

  it("o nível salvo sobrevive a recarregar (Forte -> Forte)", () => {
    saveAudioProcessing({ ...DEFAULT_AUDIO_PROCESSING, noiseSuppression: "strong" });
    expect(loadAudioProcessing().noiseSuppression).toBe("strong");
  });
});

class MeterEngine extends ProcessingEngine {
  audioCapabilities: AudioCapabilities = {
    strongNoiseSuppression: true,
    inputSensitivity: true,
    micTest: true,
  };
  monitor: boolean[] = [];
  tests = 0;
  cancels = 0;
  async setInputLevelMonitor(on: boolean) {
    this.monitor.push(on);
  }
  async startMicTest() {
    this.tests++;
  }
  cancelMicTest() {
    this.cancels++;
  }
}

describe("DeviceDialog: sensibilidade de entrada e teste do microfone", () => {
  it("engine sem a capacidade (desktop por enquanto): nada de medidor, porta ou teste", async () => {
    setVoiceEngineFactory(() => new ProcessingEngine());
    render(<DeviceDialog open onOpenChange={() => {}} />);
    await screen.findByRole("group", { name: "Redução de ruído" });
    expect(screen.queryByRole("group", { name: "Sensibilidade de entrada" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Testar" })).toBeNull();
    expect(screen.queryByRole("meter")).toBeNull();
  });

  it("sensibilidade começa desligada; Automática e Manual persistem e aplicam na engine", async () => {
    const user = userEvent.setup();
    const eng = new MeterEngine();
    setVoiceEngineFactory(() => eng);
    render(<DeviceDialog open onOpenChange={() => {}} />);
    const group = await screen.findByRole("group", { name: "Sensibilidade de entrada" });
    expect(within(group).getByRole("radio", { name: /^Desligada/ })).toBeChecked();
    await user.click(within(group).getByRole("radio", { name: /^Automática/ }));
    expect(loadAudioProcessing().inputSensitivity.mode).toBe("auto");
    await user.click(within(group).getByRole("radio", { name: /^Manual/ }));
    expect(eng.applied.at(-1)?.inputSensitivity.mode).toBe("manual");
    expect(loadAudioProcessing().inputSensitivity).toEqual({ mode: "manual", thresholdDb: -50 });
  });

  it("modo manual mostra o limiar (controle deslizante com valor lido) e o salva", async () => {
    const user = userEvent.setup();
    setVoiceEngineFactory(() => new MeterEngine());
    render(<DeviceDialog open onOpenChange={() => {}} />);
    await user.click(await screen.findByRole("radio", { name: /^Manual/ }));
    const slider = await screen.findByRole("slider", { name: /Limiar/ });
    expect(slider).toHaveAttribute("min", "-80");
    expect(slider).toHaveAttribute("max", "-20");
    fireEvent.change(slider, { target: { value: "-48" } });
    expect(loadAudioProcessing().inputSensitivity.thresholdDb).toBe(-48);
    expect(slider).toHaveAccessibleName("Limiar: -48 dB");
  });

  it("sem permissão prévia o medidor espera um clique; depois mostra o nível e a porta (e a marca do limiar no manual)", async () => {
    const user = userEvent.setup();
    const eng = new MeterEngine();
    setVoiceEngineFactory(() => eng);
    saveAudioProcessing({
      ...DEFAULT_AUDIO_PROCESSING,
      inputSensitivity: { mode: "manual", thresholdDb: -45 },
    });
    render(<DeviceDialog open onOpenChange={() => {}} />);
    expect(eng.monitor).toEqual([]); // não pediu o microfone sozinho
    await user.click(await screen.findByRole("button", { name: "Ativar medidor de nível" }));
    await waitFor(() => expect(eng.monitor).toEqual([true]));
    expect(await screen.findByRole("meter", { name: "Nível do microfone" })).toBeInTheDocument();
    expect(screen.getByTestId("meter-threshold")).toBeInTheDocument();

    act(() => useInputLevelStore.getState().set({ db: -30, gateOpen: true }));
    const meter = screen.getByRole("meter");
    expect(meter).toHaveAttribute("aria-valuenow", "-30");
    expect(meter.getAttribute("aria-valuetext")).toBe("-30 dB, porta aberta");
    expect(screen.getByTestId("gate-state")).toHaveTextContent("Porta aberta");
    act(() => useInputLevelStore.getState().set({ db: -70, gateOpen: false }));
    expect(screen.getByTestId("gate-state")).toHaveTextContent("Porta fechada");
  });

  it("fechar o diálogo desliga o medidor e cancela um teste em andamento", async () => {
    const user = userEvent.setup();
    const eng = new MeterEngine();
    setVoiceEngineFactory(() => eng);
    const { rerender } = render(<DeviceDialog open onOpenChange={() => {}} />);
    await user.click(await screen.findByRole("button", { name: "Ativar medidor de nível" }));
    await waitFor(() => expect(eng.monitor).toEqual([true]));
    rerender(<DeviceDialog open={false} onOpenChange={() => {}} />);
    await waitFor(() => expect(eng.monitor).toEqual([true, false]));
    expect(eng.cancels).toBeGreaterThan(0);
  });

  it("Testar inicia a gravação e as fases aparecem com contagem regressiva", async () => {
    const user = userEvent.setup();
    const eng = new MeterEngine();
    setVoiceEngineFactory(() => eng);
    render(<DeviceDialog open onOpenChange={() => {}} />);
    await user.click(await screen.findByRole("button", { name: "Testar" }));
    await waitFor(() => expect(eng.tests).toBe(1));
    const live = screen.getByText(/Pedindo acesso|Grave 5 segundos/);
    expect(live.closest("[aria-live]")).not.toBeNull();

    act(() => useMicTestStore.getState().set({ phase: "recording", remainingMs: 3200 }));
    expect(screen.getByText("Gravando… fale agora (4 s).")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancelar teste" })).toBeInTheDocument();
    act(() => useMicTestStore.getState().set({ phase: "playing", remainingMs: 2000 }));
    expect(screen.getByText(/Reproduzindo sua gravação \(2 s\)/)).toBeInTheDocument();
    act(() => useMicTestStore.getState().set({ phase: "done" }));
    expect(screen.getByText(/Teste concluído/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Testar" })).toBeEnabled();
  });

  it("erros do teste são explicados (permissão negada)", async () => {
    setVoiceEngineFactory(() => new MeterEngine());
    render(<DeviceDialog open onOpenChange={() => {}} />);
    await screen.findByRole("button", { name: "Testar" });
    act(() => useMicTestStore.getState().set({ phase: "error", error: "permission-denied" }));
    expect(screen.getByText(/O navegador bloqueou o microfone/)).toBeInTheDocument();
  });

  it("Cancelar teste chama a engine", async () => {
    const user = userEvent.setup();
    const eng = new MeterEngine();
    setVoiceEngineFactory(() => eng);
    render(<DeviceDialog open onOpenChange={() => {}} />);
    await screen.findByRole("button", { name: "Testar" });
    act(() => useMicTestStore.getState().set({ phase: "recording", remainingMs: 4000 }));
    const before = eng.cancels;
    await user.click(screen.getByRole("button", { name: "Cancelar teste" }));
    expect(eng.cancels).toBe(before + 1);
  });

  it("falha da porta (status da engine) aparece na tela", async () => {
    setVoiceEngineFactory(() => new MeterEngine());
    render(<DeviceDialog open onOpenChange={() => {}} />);
    await screen.findByRole("group", { name: "Redução de ruído" });
    act(() =>
      useAudioStatusStore.getState().set({
        level: "standard",
        state: "idle",
        gateError: "Não foi possível iniciar a sensibilidade de entrada.",
      }),
    );
    expect(screen.getByRole("status")).toHaveTextContent(/sensibilidade de entrada/);
  });
});

describe("sensibilidade de entrada: persistência e migração", () => {
  it("sem o campo (formato antigo) ou inválido vira 'off'; o limiar é limitado à faixa", () => {
    expect(parseInputSensitivity(undefined)).toEqual({ mode: "off", thresholdDb: -50 });
    expect(parseInputSensitivity("auto")).toEqual({ mode: "off", thresholdDb: -50 });
    expect(parseInputSensitivity({ mode: "turbo", thresholdDb: "x" })).toEqual({
      mode: "off",
      thresholdDb: -50,
    });
    expect(parseInputSensitivity({ mode: "manual", thresholdDb: -200 })).toEqual({
      mode: "manual",
      thresholdDb: -80,
    });
    expect(parseInputSensitivity({ mode: "auto", thresholdDb: 5 }).thresholdDb).toBe(-20);
  });

  it("o valor salvo sobrevive a recarregar", () => {
    saveAudioProcessing({
      ...DEFAULT_AUDIO_PROCESSING,
      inputSensitivity: { mode: "manual", thresholdDb: -35 },
    });
    expect(loadAudioProcessing().inputSensitivity).toEqual({ mode: "manual", thresholdDb: -35 });
  });

  it("dados salvos antes da porta de ruído (sem o campo) carregam com a porta desligada", () => {
    localStorage.setItem(
      "spook:voice-audio-processing",
      '{"echoCancellation":true,"noiseSuppression":"strong","autoGainControl":true}',
    );
    expect(loadAudioProcessing()).toEqual({
      echoCancellation: true,
      noiseSuppression: "strong",
      autoGainControl: true,
      inputSensitivity: { mode: "off", thresholdDb: -50 },
    });
  });
});
