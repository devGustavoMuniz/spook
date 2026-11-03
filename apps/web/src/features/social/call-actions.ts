import { acceptDMCall, cancelDMCall, declineDMCall, isApiError, ringDMCall } from "@spook/shared";
import { toast } from "sonner";
import { t } from "@/i18n";
import { appMessage } from "@/lib/app-errors";
import { joinVoice, leaveCall } from "../voice/controller";
import { useCallStore } from "./call-store";

/** A sala de voz de uma DM é o próprio canal; `title` é o nome mostrado na barra de voz. */
const target = (channelId: string, title: string) => ({
  channelId,
  guildId: null,
  channelName: title,
  canSpeak: true,
});

/** Mensagem (no idioma ativo) dos erros de chamada em DM. */
export function callMessage(err: unknown): string {
  if (!isApiError(err)) return appMessage(err);
  switch (err.status) {
    case 403:
      return err.detail
        ? err.detail.charAt(0).toUpperCase() + err.detail.slice(1)
        : t("people.call.cannotCall");
    case 404:
      return t("people.call.ended");
    case 409:
      return t("people.call.alreadyExists");
    case 429:
      return err.retryAfter
        ? t("people.call.rateLimitedIn", { seconds: err.retryAfter })
        : t("people.call.rateLimited");
    case 503:
      return t("people.call.voiceUnavailable");
    default:
      return appMessage(err);
  }
}

/**
 * "Ligar": toca o outro lado (POST /call/ring) e entra na sala. Se já há chamada na conversa (409) ou o toque não
 * está disponível, entra na sala do mesmo jeito; se o servidor recusa por outro motivo (ex.: você bloqueou a pessoa),
 * avisa e não entra.
 */
export async function placeCall(channelId: string, title: string): Promise<boolean> {
  try {
    const call = await ringDMCall(channelId);
    useCallStore.getState().setOutgoing(call);
  } catch (e) {
    // 409 (já há chamada) e 503 (voz/toque indisponíveis) não impedem de entrar na sala; falha de rede, o join explica.
    if (isApiError(e) && e.status !== 409 && e.status !== 503) {
      toast.error(callMessage(e));
      return false;
    }
  }
  const ok = await joinVoice(target(channelId, title));
  if (!ok) {
    // Não conseguiu entrar na sala: o toque não faz sentido sozinho.
    useCallStore.getState().end(channelId);
    void cancelDMCall(channelId).catch(() => {});
  }
  return ok;
}

/** "Atender": pede o token ao servidor (para o toque nas outras sessões) e entra na sala com ele. */
export async function answerCall(channelId: string, title: string): Promise<boolean> {
  try {
    const res = await acceptDMCall(channelId);
    useCallStore.getState().end(channelId);
    return await joinVoice(target(channelId, title), res.voice);
  } catch (e) {
    useCallStore.getState().end(channelId);
    toast.error(callMessage(e));
    return false;
  }
}

/** "Recusar": para o toque agora e avisa o servidor (idempotente). */
export async function declineCall(channelId: string): Promise<void> {
  useCallStore.getState().end(channelId);
  try {
    await declineDMCall(channelId);
  } catch (e) {
    toast.error(callMessage(e));
  }
}

/** "Cancelar" a chamada que eu iniciei: para o toque e sai da sala. */
export async function cancelCall(channelId: string): Promise<void> {
  useCallStore.getState().end(channelId);
  try {
    await cancelDMCall(channelId);
  } catch (e) {
    toast.error(callMessage(e));
  }
  await leaveCall();
}
