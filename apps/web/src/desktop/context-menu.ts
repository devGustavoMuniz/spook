// No app desktop o menu de contexto do WebView (Voltar, Atualizar, Imprimir...) não faz sentido: some em áreas
// vazias. Fica o nativo onde ele ajuda (campos de texto, para colar/copiar, e texto selecionado) e os menus
// próprios do Spook (que já chamam preventDefault) seguem funcionando. Em desenvolvimento o menu fica liberado,
// para inspecionar elementos.

function allowsNativeMenu(target: EventTarget | null, selection: Selection | null): boolean {
  if (selection && !selection.isCollapsed && selection.toString().trim() !== "") return true;
  if (!(target instanceof Element)) return false;
  return (
    target.closest("input, textarea, [contenteditable]:not([contenteditable='false'])") !== null
  );
}

/** Instala o bloqueio e devolve a função que o remove (usada nos testes). */
export function suppressNativeContextMenu(doc: Document = document, dev = import.meta.env.DEV) {
  if (dev) return () => {};
  const onContextMenu = (e: MouseEvent) => {
    if (e.defaultPrevented) return; // um menu próprio já tratou
    if (allowsNativeMenu(e.target, doc.getSelection())) return;
    e.preventDefault();
  };
  doc.addEventListener("contextmenu", onContextMenu);
  return () => doc.removeEventListener("contextmenu", onContextMenu);
}
