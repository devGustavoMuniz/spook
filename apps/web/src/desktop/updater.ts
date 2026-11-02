// Atualização automática do app desktop (Tauri updater). O Rust só registra os plugins `updater` e `process`; a
// decisão (quando verificar, baixar em segundo plano, esperar o fim da chamada de voz, mensagens de erro) mora aqui,
// num controlador sem React nem Tauri (o `backend` é injetável) para poder ser testado com timers falsos.
//
// Fluxo: `check` -> (achou) -> `download` automático em segundo plano -> `ready` -> a pessoa escolhe "Reiniciar para
// atualizar" (`requestRestart`) -> `install` + `relaunch`. A assinatura é conferida pelo plugin com a chave pública de
// `tauri.conf.json`; sem assinatura válida o download falha e nada é instalado.
import { create } from "zustand";
import { useVoiceStore } from "@/features/voice/store";

/** Verificação periódica com o app aberto. */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type UpdatePhase = "check" | "download" | "install";

export type UpdateStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "uptodate"; checkedAt: number }
  | { kind: "available"; version: string; notes?: string }
  | { kind: "downloading"; version: string; downloaded: number; total?: number }
  | { kind: "ready"; version: string }
  | { kind: "error"; phase: UpdatePhase; message: string; version?: string };

/** Atualização encontrada, já desacoplada do objeto do plugin. */
export type PendingUpdate = {
  version: string;
  notes?: string;
  /** Baixa e confere a assinatura; chama `onProgress` com o total de bytes baixados e o tamanho (se conhecido). */
  download: (onProgress: (downloaded: number, total?: number) => void) => Promise<void>;
  /** Instala o que foi baixado. No Windows o instalador encerra o app. */
  install: () => Promise<void>;
};

export type UpdaterBackend = {
  check: () => Promise<PendingUpdate | null>;
  relaunch: () => Promise<void>;
  currentVersion: () => Promise<string>;
};

// ---- Mensagens de erro (puras) ----

const DOWNLOAD_PAGE_HINT = "Você também pode baixar o instalador novo na página de download.";

/** Traduz o erro do plugin (texto em inglês vindo do Rust) numa frase clara para a pessoa. */
export function updateErrorMessage(err: unknown, phase: UpdatePhase): string {
  const raw = (
    typeof err === "string" ? err : err instanceof Error ? err.message : String(err ?? "")
  ).toLowerCase();
  if (/signature|minisign|verif/.test(raw)) {
    return `A assinatura da atualização não confere, então ela não foi instalada (por segurança). ${DOWNLOAD_PAGE_HINT}`;
  }
  if (
    /error sending request|network|dns|connect|timed out|timeout|offline|failed to fetch|unreachable|os error/.test(
      raw,
    )
  ) {
    return "Sem conexão com o servidor de atualizações. Verifique a internet e tente de novo.";
  }
  if (/valid release json|404|not found|status code/.test(raw)) {
    return "Ainda não há nenhuma versão publicada para atualizar.";
  }
  if (phase === "check")
    return "Não foi possível verificar as atualizações. Tente de novo mais tarde.";
  if (phase === "download") return "Não foi possível baixar a atualização. Tente de novo.";
  return `Não foi possível instalar a atualização. ${DOWNLOAD_PAGE_HINT}`;
}

/** 0..100 ou `null` quando o tamanho total é desconhecido. */
export function progressPercent(downloaded: number, total?: number): number | null {
  if (!total || total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((downloaded / total) * 100)));
}

// ---- Controlador ----

type State = {
  status: UpdateStatus;
  /** Há uma chamada de voz e a pessoa pediu para reiniciar: a interface pede confirmação. */
  confirmRestart: boolean;
};

export type UpdaterOptions = {
  now?: () => number;
  /** Chamada de voz em andamento? (padrão: o store de voz). */
  inCall?: () => boolean;
};

export function createUpdater(initial: UpdaterBackend | null, options: UpdaterOptions = {}) {
  const now = options.now ?? Date.now;
  const inCall = options.inCall ?? (() => useVoiceStore.getState().status !== "idle");
  let backend = initial;
  let pending: PendingUpdate | null = null;
  let busy = false;
  const useStore = create<State>()(() => ({ status: { kind: "idle" }, confirmRestart: false }));
  const set = (status: UpdateStatus) => useStore.setState({ status });

  async function loadBackend(): Promise<UpdaterBackend> {
    if (!backend) backend = await tauriBackend();
    return backend;
  }

  /** `manual`: a pessoa clicou em "Verificar"; erros aparecem. Automática: erro é silencioso (offline é normal). */
  async function check(opts: { manual?: boolean } = {}): Promise<void> {
    const { kind } = useStore.getState().status;
    if (busy || kind === "downloading" || kind === "ready") return;
    busy = true;
    set({ kind: "checking" });
    try {
      const found = await (await loadBackend()).check();
      if (!found) {
        pending = null;
        set({ kind: "uptodate", checkedAt: now() });
        return;
      }
      pending = found;
      set({ kind: "available", version: found.version, notes: found.notes });
    } catch (err) {
      if (opts.manual)
        set({ kind: "error", phase: "check", message: updateErrorMessage(err, "check") });
      else set({ kind: "idle" });
      return;
    } finally {
      busy = false;
    }
    await download();
  }

  /** Baixa em segundo plano a atualização encontrada (também usado para "Tentar de novo"). */
  async function download(): Promise<void> {
    const update = pending;
    if (!update || busy) return;
    busy = true;
    const version = update.version;
    set({ kind: "downloading", version, downloaded: 0 });
    let total: number | undefined;
    try {
      await update.download((downloaded, size) => {
        total = size ?? total;
        set({ kind: "downloading", version, downloaded, total });
      });
      set({ kind: "ready", version });
    } catch (err) {
      set({
        kind: "error",
        phase: "download",
        message: updateErrorMessage(err, "download"),
        version,
      });
    } finally {
      busy = false;
    }
  }

  async function installNow(): Promise<void> {
    const update = pending;
    if (!update || useStore.getState().status.kind !== "ready") return;
    const version = update.version;
    useStore.setState({ confirmRestart: false });
    try {
      await update.install();
      await (await loadBackend()).relaunch();
    } catch (err) {
      set({
        kind: "error",
        phase: "install",
        message: updateErrorMessage(err, "install"),
        version,
      });
    }
  }

  /** "Reiniciar para atualizar": nunca derruba uma chamada de voz sem a pessoa confirmar. */
  async function requestRestart(): Promise<void> {
    if (useStore.getState().status.kind !== "ready") return;
    if (inCall()) {
      useStore.setState({ confirmRestart: true });
      return;
    }
    await installNow();
  }

  return {
    useStore,
    getStatus: () => useStore.getState().status,
    check,
    download,
    requestRestart,
    /** Confirmou no diálogo (reinicia mesmo em chamada). */
    confirmRestartNow: installNow,
    dismissRestart: () => useStore.setState({ confirmRestart: false }),
    currentVersion: async () => (await loadBackend()).currentVersion(),
    /** Troca o backend (testes). */
    setBackend(next: UpdaterBackend | null) {
      backend = next;
      pending = null;
      busy = false;
      useStore.setState({ status: { kind: "idle" }, confirmRestart: false });
    },
    /**
     * Verifica a cada `UPDATE_CHECK_INTERVAL_MS` com o app aberto (a 1ª verificação é a do splash, na abertura).
     * Devolve a função que para o relógio.
     */
    startPeriodicChecks(intervalMs = UPDATE_CHECK_INTERVAL_MS): () => void {
      const id = setInterval(() => void check(), intervalMs);
      return () => clearInterval(id);
    },
  };
}

export type Updater = ReturnType<typeof createUpdater>;

/** Plugins do Tauri carregados sob demanda: a web comum nunca baixa esse código. */
async function tauriBackend(): Promise<UpdaterBackend> {
  return {
    async check() {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (!update) return null;
      let downloaded = 0;
      let total: number | undefined;
      return {
        version: update.version,
        notes: update.body || undefined,
        download: (onProgress) =>
          update.download((event) => {
            if (event.event === "Started") total = event.data.contentLength;
            else if (event.event === "Progress") downloaded += event.data.chunkLength;
            onProgress(downloaded, total);
          }),
        install: () => update.install(),
      };
    },
    async relaunch() {
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    },
    async currentVersion() {
      const { getVersion } = await import("@tauri-apps/api/app");
      return getVersion();
    },
  };
}

/** Instância única do app. */
export const updater = createUpdater(null);

export const useUpdateStatus = () => updater.useStore((s) => s.status);
