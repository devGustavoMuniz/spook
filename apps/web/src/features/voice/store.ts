import type { VoiceStatePayload } from "@spook/shared";
import { create } from "zustand";
import type { LinkQuality, VideoTrackInfo } from "./engine";

// ---- Sessão local: a chamada em que EU estou ----

export type VoiceStatus = "idle" | "connecting" | "connected" | "reconnecting";

export type VoiceSession = {
  status: VoiceStatus;
  channelId: string | null;
  /** `null` em DM. */
  guildId: string | null;
  channelName: string;
  /** O servidor já confirmou (VOICE_STATE_UPDATE) que estou neste canal. Só então uma saída vinda dele é "fui removido". */
  confirmed: boolean;
  // Intenção local; persiste ao trocar de canal (o servidor também mantém).
  selfMute: boolean;
  selfDeaf: boolean;
  /** Mute que valia antes de ensurdecer, para restaurar ao voltar a ouvir. */
  muteBeforeDeaf: boolean;
  camera: boolean;
  screen: boolean;
  speaking: ReadonlySet<string>;
  videoTracks: VideoTrackInfo[];
  quality: LinkQuality;
  audioBlocked: boolean;
};

type Actions = {
  begin: (t: { channelId: string; guildId: string | null; channelName: string }) => void;
  patch: (p: Partial<VoiceSession>) => void;
  addTrack: (t: VideoTrackInfo) => void;
  removeTrack: (id: string) => void;
  /** Volta a "fora da voz", preservando mute/deafen (a preferência do usuário). */
  clear: () => void;
  reset: () => void;
};

const initial: VoiceSession = {
  status: "idle",
  channelId: null,
  guildId: null,
  channelName: "",
  confirmed: false,
  selfMute: false,
  selfDeaf: false,
  muteBeforeDeaf: false,
  camera: false,
  screen: false,
  speaking: new Set(),
  videoTracks: [],
  quality: "unknown",
  audioBlocked: false,
};

export const useVoiceStore = create<VoiceSession & Actions>()((set) => ({
  ...initial,
  begin: (t) =>
    set({
      status: "connecting",
      channelId: t.channelId,
      guildId: t.guildId,
      channelName: t.channelName,
      confirmed: false,
      camera: false,
      screen: false,
      speaking: new Set(),
      videoTracks: [],
      quality: "unknown",
      audioBlocked: false,
    }),
  patch: (p) => set(p),
  addTrack: (t) =>
    set((s) => ({ videoTracks: [...s.videoTracks.filter((x) => x.id !== t.id), t] })),
  removeTrack: (id) => set((s) => ({ videoTracks: s.videoTracks.filter((x) => x.id !== id) })),
  clear: () =>
    set((s) => ({
      ...initial,
      selfMute: s.selfMute,
      selfDeaf: s.selfDeaf,
      muteBeforeDeaf: s.muteBeforeDeaf,
    })),
  reset: () => set(initial),
}));

export const isInVoice = (s: Pick<VoiceSession, "status">) => s.status !== "idle";

// ---- Voice states de todos os canais visíveis (gateway) ----

type StatesState = { byUser: Readonly<Record<string, VoiceStatePayload>> };
type StatesActions = {
  /** READY: o snapshot substitui tudo. */
  replaceAll: (states: readonly VoiceStatePayload[]) => void;
  /** VOICE_STATE_UPDATE: `channel_id: null` = saiu. */
  apply: (state: VoiceStatePayload) => void;
  reset: () => void;
};

export const useVoiceStatesStore = create<StatesState & StatesActions>()((set) => ({
  byUser: {},
  replaceAll: (states) =>
    set({
      byUser: Object.fromEntries(states.filter((s) => s.channel_id).map((s) => [s.user_id, s])),
    }),
  apply: (state) =>
    set((s) => {
      if (!state.channel_id) {
        if (!(state.user_id in s.byUser)) return s;
        const { [state.user_id]: _gone, ...rest } = s.byUser;
        return { byUser: rest };
      }
      return { byUser: { ...s.byUser, [state.user_id]: state } };
    }),
  reset: () => set({ byUser: {} }),
}));

/** Quem está no canal, por ordem estável de id (a ordem de chegada se perde no mapa). */
export function participantsOf(
  byUser: Readonly<Record<string, VoiceStatePayload>>,
  channelId: string,
): VoiceStatePayload[] {
  return Object.values(byUser)
    .filter((s) => s.channel_id === channelId)
    .sort((a, b) => a.user_id.length - b.user_id.length || a.user_id.localeCompare(b.user_id));
}
