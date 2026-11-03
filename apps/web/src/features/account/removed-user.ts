import { t } from "@/i18n";

/** Contas excluídas viram `removido_<id>` (as mensagens continuam; o autor aparece como "Usuário removido"). */
export const removedUserLabel = () => t("auth.account.removedUser");

export const isRemovedUsername = (username: string) => /^removido_\d+$/.test(username);

/** Nome para mostrar: o de exibição, ou o @username (ou "Usuário removido" para contas excluídas). */
export function shownName(displayName: string | undefined | null, username: string): string {
  return displayName || (isRemovedUsername(username) ? removedUserLabel() : username);
}
