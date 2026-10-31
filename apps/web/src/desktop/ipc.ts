// Única porta de entrada para a API do Tauri: o carregamento é dinâmico para que a web comum nunca
// baixe nem execute código do Tauri (e para os testes poderem trocar `invoke` por um dublê).

/** Chama um comando Rust (`#[tauri::command]`). */
export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const core = await import("@tauri-apps/api/core");
  return core.invoke<T>(cmd, args);
}
