// Guarda a última tela "de fora" das configurações para o botão fechar / Esc voltarem para ela.
let last: string | null = null;

/** Chamado a cada mudança de rota da área autenticada. */
export function trackReturnPath(href: string, inSettings: boolean, first: boolean) {
  if (inSettings) {
    // Abriu direto numa URL de configurações (link, recarga): não há "onde estava".
    if (first) last = null;
    return;
  }
  last = href;
}

/** Para onde o fechar leva: a tela anterior ou o início. */
export function returnPath(): string {
  return last ?? "/";
}
