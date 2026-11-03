import { type MessageKey, t } from "@/i18n";

/** Mensagens dos códigos de `?social_error=` devolvidos pelo backend depois do login social. */
const KEYS: Record<string, MessageKey> = {
  denied: "auth.social.denied",
  state: "auth.social.state",
  provider_error: "auth.social.providerError",
  provider_off: "auth.social.providerOff",
  no_email: "auth.social.noEmail",
  email_unverified: "auth.social.emailUnverified",
  email_in_use: "auth.social.emailInUse",
  already_linked: "auth.social.alreadyLinked",
  provider_linked: "auth.social.providerLinked",
  wrong_account: "auth.social.wrongAccount",
  need_session: "auth.social.needSession",
  need_confirm: "auth.social.needConfirm",
  internal: "auth.social.internal",
};

export function socialErrorMessage(code: string | undefined): string | undefined {
  if (!code) return undefined;
  const key = KEYS[code];
  return t(key ?? "auth.social.generic");
}
