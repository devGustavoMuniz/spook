import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeVoiceEngine } from "@/test/fake-voice-engine";
import { resetVoiceController } from "./controller";
import { DeviceDialog } from "./device-dialog";
import { DEFAULT_AUDIO_PROCESSING, loadAudioProcessing } from "./devices";
import type { AudioProcessingOptions } from "./engine";
import { setVoiceEngineFactory } from "./engine-provider";

class ProcessingEngine extends FakeVoiceEngine {
  applied: AudioProcessingOptions[] = [];
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

describe("DeviceDialog: qualidade do microfone", () => {
  it("na engine nativa mostra três interruptores, ligados por padrão", async () => {
    setVoiceEngineFactory(() => new ProcessingEngine());
    render(<DeviceDialog open onOpenChange={() => {}} />);
    for (const name of ["Cancelamento de eco", "Redução de ruído", "Ajuste automático de volume"])
      expect(await screen.findByRole("switch", { name: new RegExp(name) })).toBeChecked();
    expect(loadAudioProcessing()).toEqual(DEFAULT_AUDIO_PROCESSING);
  });

  it("desligar persiste a escolha localmente", async () => {
    const user = userEvent.setup();
    setVoiceEngineFactory(() => new ProcessingEngine());
    render(<DeviceDialog open onOpenChange={() => {}} />);
    await user.click(await screen.findByRole("switch", { name: /Cancelamento de eco/ }));
    await waitFor(() => expect(loadAudioProcessing().echoCancellation).toBe(false));
    expect(loadAudioProcessing().noiseSuppression).toBe(true);
    expect(screen.getByRole("switch", { name: /Cancelamento de eco/ })).not.toBeChecked();
  });

  it("na engine web (navegador) os interruptores não aparecem", async () => {
    setVoiceEngineFactory(() => new FakeVoiceEngine());
    render(<DeviceDialog open onOpenChange={() => {}} />);
    await screen.findByText("Dispositivos de áudio e vídeo");
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("valores salvos inválidos voltam ao padrão (tudo ligado)", () => {
    localStorage.setItem(
      "spook:voice-audio-processing",
      '{"echoCancellation":"não","noiseSuppression":false}',
    );
    expect(loadAudioProcessing()).toEqual({ ...DEFAULT_AUDIO_PROCESSING, noiseSuppression: false });
    localStorage.setItem("spook:voice-audio-processing", "lixo");
    expect(loadAudioProcessing()).toEqual(DEFAULT_AUDIO_PROCESSING);
  });
});
