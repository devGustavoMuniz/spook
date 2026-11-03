import { isApiError } from "@spook/shared";
import { getLocale, t } from "@/i18n";
import { SERVER_DETAILS } from "./server-details";

/** O 403 de quem tenta entrar por convite num servidor em que foi banido (`code: "banned"`). */
export const bannedMessage = () => t("system.error.banned");

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Texto de um `detail` do servidor (sempre em pt-BR): em inglês, traduz os conhecidos pela tabela
 * `server-details.ts`; o que não estiver lá (ou em pt-BR) é exibido como veio.
 */
export function translateDetail(detail: string): string {
  if (getLocale() === "pt-BR") return detail;
  const key = SERVER_DETAILS.get(detail.trim().replace(/\.$/, "").toLowerCase());
  return key ? t(key) : detail;
}

/** Mensagem para erros das telas de servidor/canal/mensagem (403, 404, 409, 410, 422, 429). */
export function appMessage(err: unknown): string {
  if (!isApiError(err)) return t("system.error.network");
  switch (err.status) {
    case 401:
      return t("system.error.sessionExpired");
    case 403:
      return err.code === "banned" ? bannedMessage() : t("system.error.forbidden");
    case 404:
      return t("system.error.notFound");
    case 409:
      return capitalize(translateDetail(err.detail));
    case 410:
      return t("system.error.inviteGone");
    case 422:
      return t("system.error.invalidFields");
    case 429:
      return err.retryAfter
        ? t("system.error.slowDownIn", { seconds: err.retryAfter })
        : t("system.error.tooMany");
    default:
      return err.status >= 500 ? t("system.error.server") : capitalize(translateDetail(err.detail));
  }
}

export type DmAction = "open" | "create" | "add" | "remove" | "leave" | "rename";

/** Erros das DMs (SPEC 7.4); o mesmo status quer dizer coisas diferentes por ação. */
export function dmMessage(err: unknown, action: DmAction): string {
  if (!isApiError(err)) return appMessage(err);
  switch (err.status) {
    case 403:
      return action === "open" || action === "create" || action === "add"
        ? t("system.error.dmOpen")
        : t("system.error.dmOwnerOnly");
    case 404:
      return t("system.error.dmLeft");
    case 409:
      return action === "add" ? t("system.error.dmFull") : t("system.error.dmOwnerStays");
    case 422:
      return action === "rename" ? t("system.error.dmRename") : t("system.error.dmPick");
    case 429:
      return err.retryAfter
        ? t("system.error.dmRateRetry", { seconds: err.retryAfter })
        : t("system.error.dmRate");
    default:
      return appMessage(err);
  }
}

/** Erros de `POST /channels/{id}/voice/token` e do restante da voz (SPEC 7.7). */
export function voiceMessage(err: unknown): string {
  if (!isApiError(err)) return appMessage(err);
  switch (err.status) {
    case 403:
      return t("system.error.voiceForbidden");
    case 404:
      return t("system.error.voiceNotFound");
    case 422:
      return t("system.error.voiceType");
    case 503:
      return t("system.error.voiceDown");
    default:
      return appMessage(err);
  }
}
