/** Estamos dentro do webview do Tauri? (o `__TAURI_INTERNALS__` é injetado antes do app carregar) */
export const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
