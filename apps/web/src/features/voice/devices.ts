// Dispositivos escolhidos (microfone, alto-falante, câmera): conveniência por navegador, em localStorage.
import type { AudioProcessingOptions, DeviceKind, NoiseSuppressionLevel } from "./engine";

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

// ---- Processamento de áudio (eco, ruído, ganho): web e desktop ----

const AP_KEY = "spook:voice-audio-processing";

export const DEFAULT_AUDIO_PROCESSING: AudioProcessingOptions = {
  echoCancellation: true,
  noiseSuppression: "standard",
  autoGainControl: true,
};

const LEVELS: readonly NoiseSuppressionLevel[] = ["off", "standard", "strong"];

/**
 * Lê o nível de ruído salvo. O formato antigo era booleano (true = filtro ligado, false = desligado):
 * migra para `standard`/`off`. Qualquer outra coisa vira `undefined` (usa o padrão).
 */
export function parseNoiseSuppression(raw: unknown): NoiseSuppressionLevel | undefined {
  if (raw === true) return "standard";
  if (raw === false) return "off";
  return LEVELS.find((l) => l === raw);
}

/** Tudo ligado (ruído em "Padrão") por padrão; só valores válidos substituem o padrão. */
export function loadAudioProcessing(): AudioProcessingOptions {
  try {
    const raw = JSON.parse(localStorage.getItem(AP_KEY) ?? "{}") as Record<string, unknown>;
    const out = { ...DEFAULT_AUDIO_PROCESSING };
    if (typeof raw.echoCancellation === "boolean") out.echoCancellation = raw.echoCancellation;
    if (typeof raw.autoGainControl === "boolean") out.autoGainControl = raw.autoGainControl;
    out.noiseSuppression = parseNoiseSuppression(raw.noiseSuppression) ?? out.noiseSuppression;
    if (typeof raw.noiseSuppression === "boolean") saveAudioProcessing(out); // migração do formato antigo
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

// ---- Compartilhamento de tela ----

const SS_KEY = "spook:voice-screen-share";

export type ScreenSharePrefs = { audio: boolean };

/** O áudio do compartilhamento começa DESLIGADO (evita o eco de a chamada voltar pelo áudio da tela). */
export function loadScreenSharePrefs(): ScreenSharePrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(SS_KEY) ?? "{}") as Partial<ScreenSharePrefs>;
    return { audio: raw.audio === true };
  } catch {
    return { audio: false };
  }
}

export function saveScreenSharePrefs(prefs: ScreenSharePrefs) {
  try {
    localStorage.setItem(SS_KEY, JSON.stringify(prefs));
  } catch {
    // armazenamento indisponível: vale só nesta sessão
  }
}
