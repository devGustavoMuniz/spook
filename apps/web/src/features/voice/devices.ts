// Dispositivos escolhidos (microfone, alto-falante, câmera): conveniência por navegador, em localStorage.
import type { DeviceKind } from "./engine";

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
