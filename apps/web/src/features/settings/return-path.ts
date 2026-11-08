// A última seção vista das configurações, que a engrenagem reabre. (As configurações são um modal sobre a tela em
// que a pessoa estava: a rota continua a mesma e o modal é o parâmetro `?settings=`, mascarado como
// `/settings/<seção>`; "de onde veio" fica no `state` da entrada do histórico, veja `use-settings.tsx`.)

const LAST_KEY = "spook:settings-section";
export function loadLastSection(): string | null {
  try {
    return localStorage.getItem(LAST_KEY);
  } catch {
    return null;
  }
}

export function saveLastSection(key: string) {
  try {
    localStorage.setItem(LAST_KEY, key);
  } catch {
    // sem armazenamento (janela privativa): a seção lembrada é só uma conveniência
  }
}
