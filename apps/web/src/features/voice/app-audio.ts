// Áudio por aplicativo no compartilhamento de tela (só desktop): preferências locais e montagem do parâmetro.
// Os aplicativos são lembrados pelo nome do executável (`spotify.exe`), nunca por PID (o PID muda a cada execução).

import type { AppAudioMode, AppAudioOptions, AudioApp } from "./engine";

const KEY = "spook:voice-screen-app-audio";

export type AppAudioPrefs = {
  mode: AppAudioMode;
  /** Volume master, 0 a 100. */
  master: number;
  /** Escolhas por executável: marcado e volume (0 a 100). Quem não está aqui começa desmarcado em 100. */
  apps: Record<string, { selected: boolean; volume: number }>;
};

export const DEFAULT_APP_AUDIO_PREFS: AppAudioPrefs = { mode: "system", master: 100, apps: {} };

/** Inteiro de 0 a 100; qualquer lixo vira `fallback`. */
export function clampPercent(n: unknown, fallback = 100): number {
  return typeof n === "number" && Number.isFinite(n)
    ? Math.min(100, Math.max(0, Math.round(n)))
    : fallback;
}

/** Chave estável de um executável: minúscula e sem pasta. */
export function exeKey(exe: string): string {
  const name = exe.trim().split(/[\\/]/).pop() ?? "";
  return name.toLowerCase();
}

export function loadAppAudioPrefs(): AppAudioPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<AppAudioPrefs>;
    const apps: AppAudioPrefs["apps"] = {};
    if (raw.apps && typeof raw.apps === "object") {
      for (const [exe, v] of Object.entries(raw.apps)) {
        const key = exeKey(exe);
        if (key && v && typeof v === "object")
          apps[key] = {
            selected: (v as { selected?: unknown }).selected === true,
            volume: clampPercent((v as { volume?: unknown }).volume),
          };
      }
    }
    return {
      mode: raw.mode === "apps" ? "apps" : "system",
      master: clampPercent(raw.master),
      apps,
    };
  } catch {
    return { ...DEFAULT_APP_AUDIO_PREFS, apps: {} };
  }
}

export function saveAppAudioPrefs(prefs: AppAudioPrefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // armazenamento indisponível: vale só nesta sessão
  }
}

/**
 * O próprio Spook (e o WebView dele) NUNCA entra no áudio compartilhado: a chamada voltaria como eco. O Rust já
 * o tira da lista e da captura; esta é a segunda barreira, pelo nome do executável.
 */
export function isSelfApp(exe: string): boolean {
  return /^spook(-desktop)?(\.exe)?$/.test(exeKey(exe));
}

/** Linha da lista: um aplicativo que está na lista do SO ou que foi marcado antes e não está tocando agora. */
export type AppAudioRow = {
  exe: string;
  name: string;
  icon?: string;
  playing: boolean;
  /** Está com sessão de áudio agora (`false` = marcado antes, hoje fechado/sem som). */
  present: boolean;
};

/** Nome para um aplicativo que não está na lista agora: `spotify.exe` vira `Spotify` (igual ao do Rust). */
function prettyName(exe: string): string {
  const stem = exe.replace(/\.exe$/, "");
  return stem.charAt(0).toUpperCase() + stem.slice(1);
}

/** Junta a lista do SO (sem o Spook) com o que ficou marcado nas preferências, sem repetir executável. */
export function buildRows(apps: AudioApp[], prefs: AppAudioPrefs): AppAudioRow[] {
  const rows = new Map<string, AppAudioRow>();
  for (const a of apps) {
    const exe = exeKey(a.exe || a.id);
    if (!exe || isSelfApp(exe)) continue;
    const prev = rows.get(exe);
    rows.set(exe, {
      exe,
      name: prev?.name ?? a.name ?? exe,
      ...(a.icon || prev?.icon ? { icon: a.icon ?? prev?.icon } : {}),
      playing: (prev?.playing ?? false) || a.playing === true,
      present: true,
    });
  }
  for (const [exe, v] of Object.entries(prefs.apps)) {
    if (v.selected && !rows.has(exe) && !isSelfApp(exe))
      rows.set(exe, { exe, name: prettyName(exe), playing: false, present: false });
  }
  return [...rows.values()].sort(
    (a, b) =>
      Number(b.present) - Number(a.present) ||
      Number(b.playing) - Number(a.playing) ||
      a.name.localeCompare(b.name),
  );
}

/** Quantos aplicativos estão marcados (sem o Spook). */
export function selectedCount(prefs: AppAudioPrefs): number {
  return Object.entries(prefs.apps).filter(([exe, v]) => v.selected && !isSelfApp(exe)).length;
}

/** Parâmetro enviado ao motor: todo o sistema (menos o Spook), ou só os marcados com os volumes. */
export function buildAppAudioOptions(prefs: AppAudioPrefs): AppAudioOptions {
  if (prefs.mode === "system") return { mode: "system", master: 100, apps: [] };
  return {
    mode: "apps",
    master: prefs.master,
    apps: Object.entries(prefs.apps)
      .filter(([exe, v]) => v.selected && !isSelfApp(exe))
      .map(([exe, v]) => ({ exe, volume: v.volume })),
  };
}
