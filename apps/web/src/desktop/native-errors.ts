// Erros do núcleo Rust (`VoiceError` serializado) → os tipos que a interface já usa. O Rust devolve a
// mensagem em pt-br com a instrução do SO certo (ex.: macOS → Ajustes do Sistema > Privacidade e
// Segurança); ela vai em `userMessage` e é o que o `mediaMessage` mostra.
import {
  type ConnectErrorCode,
  type MediaErrorCode,
  VoiceConnectError,
  VoiceMediaError,
} from "@/features/voice/engine";

export type NativeVoiceError =
  | { kind: "connect"; code: ConnectErrorCode; message: string }
  | {
      kind: "media";
      code: MediaErrorCode;
      device: "microphone" | "camera" | "screen" | "speaker";
      message: string;
    }
  | { kind: "other"; message: string };

type Device = "microphone" | "camera" | "screen";

const MEDIA_CODES: MediaErrorCode[] = [
  "permission-denied",
  "cancelled",
  "not-found",
  "in-use",
  "unsupported",
  "unknown",
];
const CONNECT_CODES: ConnectErrorCode[] = ["token-rejected", "unreachable", "unknown"];

function asNative(err: unknown): NativeVoiceError | null {
  if (typeof err === "object" && err !== null && "kind" in err) {
    const e = err as { kind?: unknown };
    if (e.kind === "connect" || e.kind === "media" || e.kind === "other")
      return err as NativeVoiceError;
  }
  return null;
}

export function toMediaError(err: unknown, device: Device): VoiceMediaError {
  if (err instanceof VoiceMediaError) return err;
  const n = asNative(err);
  if (n?.kind === "media") {
    const code = MEDIA_CODES.includes(n.code) ? n.code : "unknown";
    const dev: Device = n.device === "speaker" ? "microphone" : n.device;
    return new VoiceMediaError(code, dev, n.message, n.message);
  }
  if (n?.kind === "other") return new VoiceMediaError("unknown", device, n.message, n.message);
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : undefined;
  return new VoiceMediaError("unknown", device, message);
}

export function toConnectError(err: unknown): VoiceConnectError {
  if (err instanceof VoiceConnectError) return err;
  const n = asNative(err);
  if (n?.kind === "connect") {
    const code = CONNECT_CODES.includes(n.code) ? n.code : "unknown";
    return new VoiceConnectError(code, n.message);
  }
  if (n) return new VoiceConnectError("unknown", n.message);
  return new VoiceConnectError("unknown", err instanceof Error ? err.message : undefined);
}
