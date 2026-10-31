// Volume local por pessoa (só quem ouve é afetado): voz e áudio da tela, mais "silenciar só para mim".
// Persistido em localStorage por id de usuário (try/catch: indisponível = vale só nesta sessão).
import { create } from "zustand";
import type { AudioSource } from "./engine";

const KEY = "spook:voice-participant-volumes";

/** `voice`/`screen` em fração (1 = 100%); `muted` = "silenciar só para mim" (o volume guardado não se perde). */
export type PersonVolume = { voice: number; screen: number; muted: boolean };

export const DEFAULT_PERSON_VOLUME: PersonVolume = { voice: 1, screen: 1, muted: false };

/** Teto que a interface nunca ultrapassa, mesmo que a engine aceite mais (Discord vai a 200%). */
export const ABSOLUTE_MAX_VOLUME = 2;

const clampVolume = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(ABSOLUTE_MAX_VOLUME, Math.max(0, v)) : 1;

const isDefault = (v: PersonVolume) => v.voice === 1 && v.screen === 1 && !v.muted;

function loadAll(): Record<string, PersonVolume> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, unknown>;
    const out: Record<string, PersonVolume> = {};
    for (const [id, value] of Object.entries(raw)) {
      if (typeof value !== "object" || value === null) continue;
      const r = value as Record<string, unknown>;
      const v: PersonVolume = {
        voice: clampVolume(r.voice),
        screen: clampVolume(r.screen),
        muted: r.muted === true,
      };
      if (!isDefault(v)) out[id] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function saveAll(all: Record<string, PersonVolume>) {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // armazenamento indisponível: vale só nesta sessão
  }
}

type VolumeStore = {
  byUser: Readonly<Record<string, PersonVolume>>;
  set: (userId: string, patch: Partial<PersonVolume>) => void;
  /** Só para testes: relê o que está salvo. */
  reload: () => void;
};

export const useParticipantVolumeStore = create<VolumeStore>()((set, get) => ({
  byUser: loadAll(),
  set: (userId, patch) => {
    const cur = get().byUser[userId] ?? DEFAULT_PERSON_VOLUME;
    const next: PersonVolume = {
      voice: patch.voice === undefined ? cur.voice : clampVolume(patch.voice),
      screen: patch.screen === undefined ? cur.screen : clampVolume(patch.screen),
      muted: patch.muted ?? cur.muted,
    };
    const { [userId]: _old, ...rest } = get().byUser;
    const byUser = isDefault(next) ? rest : { ...rest, [userId]: next };
    saveAll(byUser);
    set({ byUser });
  },
  reload: () => set({ byUser: loadAll() }),
}));

export const personVolumeOf = (
  byUser: Readonly<Record<string, PersonVolume>>,
  userId: string,
): PersonVolume => byUser[userId] ?? DEFAULT_PERSON_VOLUME;

/** O que a engine recebe: 0 se silenciado só para mim; senão o volume da origem limitado ao máximo da engine. */
export function effectiveVolume(v: PersonVolume, source: AudioSource, max: number): number {
  return v.muted ? 0 : Math.min(max, v[source]);
}
