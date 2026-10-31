// Dispositivos escolhidos (microfone, alto-falante, câmera): conveniência por navegador, em localStorage.
import type { AudioProcessingOptions, DeviceKind } from "./engine";

const KEY = "spook:voice-devices";

export type DevicePrefs = Partial<Record<DeviceKind, string>>;

export function loadDevicePrefs(): DevicePrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as DevicePrefs;
    const out: DevicePrefs = {};
    for (const k of ["audioinput", "audiooutput", "videoinput"] as const)
      if (typeof raw[k] === "string") out[k] = raw[k];
    return out;
  } catch {
    return {};
  }
}

export function saveDevicePref(kind: DeviceKind, deviceId: string | undefined) {
  try {
    const next = { ...loadDevicePrefs() };
    if (deviceId) next[kind] = deviceId;
    else delete next[kind];
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // armazenamento indisponível: vale só nesta sessão
  }
}

// ---- Processamento de áudio do desktop (eco, ruído, ganho) ----

const AP_KEY = "spook:voice-audio-processing";

export const DEFAULT_AUDIO_PROCESSING: AudioProcessingOptions = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

/** Tudo ligado por padrão; só valores booleanos válidos substituem o padrão. */
export function loadAudioProcessing(): AudioProcessingOptions {
  try {
    const raw = JSON.parse(localStorage.getItem(AP_KEY) ?? "{}") as Partial<AudioProcessingOptions>;
    const out = { ...DEFAULT_AUDIO_PROCESSING };
    for (const k of Object.keys(out) as (keyof AudioProcessingOptions)[])
      if (typeof raw[k] === "boolean") out[k] = raw[k];
    return out;
  } catch {
    return { ...DEFAULT_AUDIO_PROCESSING };
  }
}

export function saveAudioProcessing(options: AudioProcessingOptions) {
  try {
    localStorage.setItem(AP_KEY, JSON.stringify(options));
  } catch {
    // armazenamento indisponível: vale só nesta sessão
  }
}
