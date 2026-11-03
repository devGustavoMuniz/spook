import { create } from "zustand";
import { t } from "@/i18n";

/** "Digitando…" expira 8 s depois do último evento (SPEC 7.6); o servidor não manda o fim. */
export const TYPING_TTL_MS = 8_000;

type TypingState = {
  /** channel_id → user_ids digitando, na ordem em que começaram. */
  byChannel: Readonly<Record<string, readonly string[]>>;
};
type TypingActions = {
  /** Chegou um TYPING_START: (re)arma os 8 s dessa pessoa nesse canal. */
  start: (channelId: string, userId: string) => void;
  /** A pessoa enviou a mensagem (ou saiu): o indicador some na hora. */
  stop: (channelId: string, userId: string) => void;
  reset: () => void;
};

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const timerKey = (channelId: string, userId: string) => `${channelId}:${userId}`;

export const useTypingStore = create<TypingState & TypingActions>()((set, get) => ({
  byChannel: {},
  start: (channelId, userId) => {
    const key = timerKey(channelId, userId);
    const old = timers.get(key);
    if (old) clearTimeout(old);
    timers.set(
      key,
      setTimeout(() => get().stop(channelId, userId), TYPING_TTL_MS),
    );
    set((s) => {
      const cur = s.byChannel[channelId] ?? [];
      if (cur.includes(userId)) return s;
      return { byChannel: { ...s.byChannel, [channelId]: [...cur, userId] } };
    });
  },
  stop: (channelId, userId) => {
    const key = timerKey(channelId, userId);
    const t = timers.get(key);
    if (t) clearTimeout(t);
    timers.delete(key);
    set((s) => {
      const cur = s.byChannel[channelId];
      if (!cur?.includes(userId)) return s;
      const next = cur.filter((u) => u !== userId);
      const { [channelId]: _old, ...rest } = s.byChannel;
      return { byChannel: next.length > 0 ? { ...rest, [channelId]: next } : rest };
    });
  },
  reset: () => {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    set({ byChannel: {} });
  },
}));

const NONE: readonly string[] = [];
export const useTypingUsers = (channelId: string): readonly string[] =>
  useTypingStore((s) => s.byChannel[channelId] ?? NONE);

/** Texto do indicador: 1, 2 ou "várias pessoas". `names` já exclui o próprio usuário. */
export function typingText(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  if (names.length === 1) return t("settings.typing.one", { name: names[0] ?? "" });
  if (names.length === 2)
    return t("settings.typing.two", { first: names[0] ?? "", second: names[1] ?? "" });
  return t("settings.typing.many");
}
