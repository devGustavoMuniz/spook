/** Contas excluídas viram `removido_<id>` (as mensagens continuam; o autor aparece como "Usuário removido"). */
export const REMOVED_USER_LABEL = "Usuário removido";

export const isRemovedUsername = (username: string) => /^removido_\d+$/.test(username);

/** Nome para mostrar: o de exibição, ou o @username (ou "Usuário removido" para contas excluídas). */
export function shownName(displayName: string | undefined | null, username: string): string {
  return displayName || (isRemovedUsername(username) ? REMOVED_USER_LABEL : username);
}
