import { type MessageKey, t } from "@/i18n";
import { VoiceMediaError } from "./engine";

/** Mensagem amigável (pt-br) para falhas de microfone, câmera e tela. */
export function mediaMessage(err: unknown): string {
  if (!(err instanceof VoiceMediaError)) return t("voice.media.deviceFallback");
  if (err.userMessage) return err.userMessage;
  const whatKey: Record<typeof err.device, MessageKey> = {
    microphone: "voice.media.microphone",
    camera: "voice.media.cameraName",
    screen: "voice.media.screenName",
  };
  const what = t(whatKey[err.device]);
  switch (err.code) {
    case "permission-denied":
      return t("voice.media.denied", { what });
    case "cancelled":
      return t("voice.media.cancelled");
    case "not-found":
      return t("voice.media.notFound", { what });
    case "in-use":
      return t("voice.media.inUse", { what });
    case "unsupported":
      return t("voice.media.unsupported");
    default:
      return t("voice.media.generic", { what });
  }
}
