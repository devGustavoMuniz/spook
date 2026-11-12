// Dispositivos escolhidos (microfone, alto-falante, câmera): conveniência por navegador, em localStorage.
import type {
  AudioProcessingOptions,
  DeviceKind,
  InputSensitivity,
  NoiseSuppressionLevel,
} from "./engine";

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
  inputSensitivity: { mode: "off", thresholdDb: -50 },
};

/** Faixa do limiar manual da porta de ruído, em dBFS. */
export const SENSITIVITY_RANGE = { min: -80, max: -20 } as const;

/**
 * Lê a sensibilidade salva. Valor ausente ou inválido (inclusive o formato antigo, que não tinha o campo) vira
 * `off`: quem já usava o app não passa a ter a porta ligada sem querer.
 */
export function parseInputSensitivity(raw: unknown): InputSensitivity {
  const out = { ...DEFAULT_AUDIO_PROCESSING.inputSensitivity };
  if (typeof raw !== "object" || raw === null) return out;
  const r = raw as Record<string, unknown>;
  if (r.mode === "auto" || r.mode === "manual" || r.mode === "off") out.mode = r.mode;
  if (typeof r.thresholdDb === "number" && Number.isFinite(r.thresholdDb))
    out.thresholdDb = Math.min(
      SENSITIVITY_RANGE.max,
      Math.max(SENSITIVITY_RANGE.min, Math.round(r.thresholdDb)),
    );
  return out;
}

const LEVELS: readonly NoiseSuppressionLevel[] = ["off", "standard", "strong", "max"];

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
    out.inputSensitivity = parseInputSensitivity(raw.inputSensitivity);
    // migração do formato antigo (ruído booleano): regrava no formato novo. Sem `inputSensitivity` salvo = `off`.
    if (typeof raw.noiseSuppression === "boolean") saveAudioProcessing(out);
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

export type ScreenSharePrefs = {
  audio: boolean;
  /** Mostrar uma miniatura da tela para quem vê o canal (padrão LIGADO, como no Discord). */
  preview: boolean;
};

/**
 * O áudio do compartilhamento começa DESLIGADO (evita o eco de a chamada voltar pelo áudio da tela) e a prévia
 * LIGADA. Registros antigos, só com `audio`, ganham a prévia no padrão.
 */
export function loadScreenSharePrefs(): ScreenSharePrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(SS_KEY) ?? "{}") as Partial<ScreenSharePrefs>;
    return { audio: raw.audio === true, preview: raw.preview !== false };
  } catch {
    return { audio: false, preview: true };
  }
}

/** Grava só os campos informados; os demais continuam como estavam. */
export function saveScreenSharePrefs(prefs: Partial<ScreenSharePrefs>) {
  try {
    localStorage.setItem(SS_KEY, JSON.stringify({ ...loadScreenSharePrefs(), ...prefs }));
  } catch {
    // armazenamento indisponível: vale só nesta sessão
  }
}

// ---- Prévias das transmissões de OUTRAS pessoas (quem assiste) ----

const VIEW_PREVIEWS_KEY = "spook:voice-view-stream-previews";

/** "Mostrar prévias das transmissões" (Configurações > Voz e vídeo). Padrão LIGADO. */
export function loadViewStreamPreviews(): boolean {
  try {
    return localStorage.getItem(VIEW_PREVIEWS_KEY) !== "off";
  } catch {
    return true;
  }
}

export function saveViewStreamPreviews(on: boolean) {
  try {
    localStorage.setItem(VIEW_PREVIEWS_KEY, on ? "on" : "off");
  } catch {
    // armazenamento indisponível: vale só nesta sessão
  }
}
