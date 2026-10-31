import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeVoiceEngine } from "@/test/fake-voice-engine";
import { resetVoiceController } from "./controller";
import { DeviceDialog, noiseStatusText } from "./device-dialog";
import {
  DEFAULT_AUDIO_PROCESSING,
  loadAudioProcessing,
  parseNoiseSuppression,
  saveAudioProcessing,
} from "./devices";
import type { AudioCapabilities, AudioProcessingOptions } from "./engine";
import { setVoiceEngineFactory } from "./engine-provider";
import { useAudioStatusStore } from "./store";

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
