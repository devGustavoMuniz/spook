// Casca do app desktop vista do webview: configurações (bandeja, início com o sistema), contador no ícone e a
// heurística de "clicar na notificação abre o canal". Tudo conversa com o Rust por `invoke` (src-tauri/src/shell.rs).
import { t } from "@/i18n";
import { invoke } from "./ipc";
import { takeRecentNotification } from "./notifier";

/** Interruptores guardados pelo Rust (arquivo JSON no diretório de configuração; sem segredos). */
export type AppSettings = {
  /** Fechar a janela esconde o app na bandeja (padrão ligado, como o Discord). */
  closeToTray: boolean;
  /** Fechar a janela com uma chamada em andamento mantém a chamada na bandeja (padrão desligado: sai da chamada). */
  keepCallOnClose: boolean;
  /** Abrir o Spook ao iniciar a sessão do sistema (padrão desligado). */
  startWithSystem: boolean;
  /** Na abertura automática, ficar só na bandeja, sem janela (padrão desligado). */
  startMinimized: boolean;
};

export const getAppSettings = () => invoke<AppSettings>("app_get_settings");

export const setAppSettings = (settings: AppSettings) =>
  invoke<AppSettings>("app_set_settings", { settings });

/** Texto de erro de um comando do shell (o Rust devolve `Err(String)`). */
export function shellErrorMessage(err: unknown): string {
  if (typeof err === "string" && err) return err;
  if (err instanceof Error && err.message) return err.message;
  return t("settings.desktop.saveFailed");
}

/** Repassa o idioma da interface ao Rust (menu da bandeja e aviso de "continua rodando"). Falha é ignorada. */
export const setNativeLocale = (locale: string) =>
  invoke("app_set_locale", { locale }).catch(() => {});

// ---- Contador no ícone ----

/** Espera as menções/DMs se acalmarem antes de falar com o SO (uma rajada de mensagens = uma chamada). */
export const BADGE_DEBOUNCE_MS = 250;

export type BadgeSync = { set: (count: number) => void; flush: (count: number) => void };

/**
 * Manda a contagem ao Rust com debounce e sem repetir o mesmo valor. `flush` envia na hora (ao sair da conta ou
 * desmontar). Falha do comando é ignorada (o contador é só um enfeite): o próximo valor tenta de novo.
 */
export function createBadgeSync(
  send: (count: number) => Promise<unknown> = (count) => invoke("app_set_badge", { count }),
  debounceMs = BADGE_DEBOUNCE_MS,
): BadgeSync {
  let last: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const push = (count: number) => {
    const value = Math.max(0, Math.floor(Number.isFinite(count) ? count : 0));
    if (value === last) return;
    last = value;
    void send(value).catch(() => {
      last = null;
    });
  };
  return {
    set(count) {
      clearTimeout(timer);
      timer = setTimeout(() => push(count), debounceMs);
    },
    flush(count) {
      clearTimeout(timer);
      push(count);
    },
  };
}

export const appBadge = createBadgeSync();

// ---- Fechar a janela estando em chamada ----

/** Evento que o Rust emite depois de tirar o usuário da chamada porque a janela foi fechada (`keepCallOnClose` desligado). */
export const CALL_LEFT_EVENT = "app://call-left";

/**
 * Escuta `CALL_LEFT_EVENT`: o Rust já desconectou a sala; `onLeft` faz o resto (limpar a interface e avisar o
 * servidor). Devolve a função que desfaz. Falha ao registrar é ignorada (o servidor remove pelo webhook).
 */
export function installCallLeftListener(
  onLeft: () => void,
  listen: (cb: () => void) => Promise<() => void> = async (cb) => {
    const evt = await import("@tauri-apps/api/event");
    return evt.listen(CALL_LEFT_EVENT, () => cb());
  },
): () => void {
  let disposed = false;
  let off: (() => void) | null = null;
  listen(onLeft)
    .then((un) => {
      if (disposed) un();
      else off = un;
    })
    .catch(() => {});
  return () => {
    disposed = true;
    off?.();
    off = null;
  };
}

// ---- Clicar na notificação ----

/** Evento que o Rust emite quando traz a janela à frente por conta própria (bandeja, segunda instância, Dock). */
export const ACTIVATED_EVENT = "app://activated";

/** Escuta o foco da janela e o evento de ativação; devolve a função que desfaz tudo. */
export type ActivationSource = (onActivate: () => void) => Promise<() => void>;

export const tauriActivationSource: ActivationSource = async (onActivate) => {
  const [win, evt] = await Promise.all([
    import("@tauri-apps/api/window"),
    import("@tauri-apps/api/event"),
  ]);
  const offs = await Promise.all([
    win.getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused) onActivate();
    }),
    evt.listen(ACTIVATED_EVENT, () => onActivate()),
  ]);
  return () => {
    for (const off of offs) off();
  };
};

/**
 * O plugin de notificação do desktop não avisa o clique. Heurística: se a janela ganhar foco poucos segundos depois
 * da última notificação nativa e ela ainda não foi usada, abre o canal dela UMA vez (`notifier.ts` guarda o
 * `{ url, at }`). Alt-tab dentro da janela de tempo também navega (limitação documentada).
 */
export function installNotificationClick(
  navigate: (url: string) => void,
  source: ActivationSource = tauriActivationSource,
): () => void {
  let disposed = false;
  let off: (() => void) | null = null;
  const onActivate = () => {
    const url = takeRecentNotification();
    if (url) navigate(url);
  };
  source(onActivate)
    .then((un) => {
      if (disposed) un();
      else off = un;
    })
    .catch(() => {});
  return () => {
    disposed = true;
    off?.();
    off = null;
  };
}
