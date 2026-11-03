import {
  deleteNotificationSetting,
  type NotificationLevel,
  type NotificationSettingPayload,
  putNotificationSetting,
} from "@spook/shared";
import { create } from "zustand";
import type { MessageKey } from "@/i18n";

/**
 * Silêncio e nível de notificação por servidor, canal ou DM (SPEC 5.5, adicional). Herança do nível:
 * canal/DM -> servidor -> padrão (servidor: só menções; DM: tudo). Silêncio vale se o canal OU o servidor
 * estiverem silenciados. Só os avisos mudam: as contagens de não lidas e menções seguem iguais.
 */

export type Scope = "guild" | "channel";
export type MuteChoice = number | "forever";

/** Durações do submenu "Silenciar por…" (minutos). */
export const MUTE_OPTIONS: readonly { labelKey: MessageKey; value: MuteChoice }[] = [
  { labelKey: "settings.mute.15m", value: 15 },
  { labelKey: "settings.mute.1h", value: 60 },
  { labelKey: "settings.mute.8h", value: 8 * 60 },
  { labelKey: "settings.mute.24h", value: 24 * 60 },
  { labelKey: "settings.mute.forever", value: "forever" },
];

export const LEVEL_OPTIONS: readonly { labelKey: MessageKey; value: NotificationLevel }[] = [
  { labelKey: "settings.level.all", value: "all" },
  { labelKey: "settings.level.mentions", value: "mentions" },
  { labelKey: "settings.level.none", value: "none" },
];

export const keyOf = (scope: Scope, id: string) => `${scope}:${id}`;

/** O silêncio vale agora? (vencido deixa de valer sem precisar de aviso do servidor.) */
export function isMutedEntry(e: NotificationSettingPayload | undefined, now = Date.now()) {
  if (!e?.muted) return false;
  return !e.muted_until || Date.parse(e.muted_until) > now;
}

export function defaultLevel(isGuild: boolean): NotificationLevel {
  return isGuild ? "mentions" : "all";
}

type Entries = Readonly<Record<string, NotificationSettingPayload>>;

/** Silêncio e nível efetivos de um canal (guildId ausente = DM). */
export function effective(
  entries: Entries,
  target: { guildId?: string; channelId: string },
  now = Date.now(),
): { muted: boolean; level: NotificationLevel } {
  const ch = entries[keyOf("channel", target.channelId)];
  const gu = target.guildId ? entries[keyOf("guild", target.guildId)] : undefined;
  return {
    muted: isMutedEntry(ch, now) || isMutedEntry(gu, now),
    level: ch?.level ?? gu?.level ?? defaultLevel(!!target.guildId),
  };
}

type State = {
  entries: Entries;
  /** Sobe quando algum silêncio vence, para os indicadores se atualizarem sozinhos. */
  tick: number;
};

type Actions = {
  replaceAll: (list: readonly NotificationSettingPayload[]) => void;
  /** Evento do servidor ou resposta de uma ação: sem silêncio e sem nível = padrão (remove). */
  apply: (e: NotificationSettingPayload) => void;
  reset: () => void;
};

let timer: ReturnType<typeof setTimeout> | undefined;

export const useNotificationSettings = create<State & Actions>()((set, get) => {
  /** Agenda um tick para o próximo vencimento (máx. ~24 dias, o limite do setTimeout). */
  function schedule() {
    clearTimeout(timer);
    const now = Date.now();
    let next = Number.POSITIVE_INFINITY;
    for (const e of Object.values(get().entries)) {
      if (e.muted && e.muted_until) {
        const t = Date.parse(e.muted_until);
        if (t > now) next = Math.min(next, t);
      }
    }
    if (next === Number.POSITIVE_INFINITY) return;
    timer = setTimeout(
      () => {
        set((s) => ({ tick: s.tick + 1 }));
        schedule();
      },
      Math.min(next - now + 50, 2_000_000_000),
    );
  }
  return {
    entries: {},
    tick: 0,
    replaceAll: (list) => {
      set({
        entries: Object.fromEntries(
          list
            .filter((e) => e.muted || e.level || e.suppress_everyone)
            .map((e) => [keyOf(e.scope, e.target_id), e] as const),
        ),
      });
      schedule();
    },
    apply: (e) => {
      set((s) => {
        const { [keyOf(e.scope, e.target_id)]: _old, ...rest } = s.entries;
        return {
          entries:
            e.muted || e.level || e.suppress_everyone
              ? { ...rest, [keyOf(e.scope, e.target_id)]: e }
              : rest,
        };
      });
      schedule();
    },
    reset: () => {
      clearTimeout(timer);
      set({ entries: {}, tick: 0 });
    },
  };
});

/** Silêncio/nível próprios de um alvo (sem herança), para os menus. */
export function useSetting(scope: Scope, id: string): NotificationSettingPayload | undefined {
  return useNotificationSettings((s) => s.entries[keyOf(scope, id)]);
}

/** O alvo está silenciado agora (dele mesmo)? Reage ao vencimento. */
export function useIsMuted(scope: Scope, id: string): boolean {
  return useNotificationSettings((s) => {
    void s.tick;
    return isMutedEntry(s.entries[keyOf(scope, id)]);
  });
}

/** Canal efetivamente silenciado (por ele ou pelo servidor). */
export function useIsChannelMuted(guildId: string | undefined, channelId: string): boolean {
  return useNotificationSettings((s) => {
    void s.tick;
    return effective(s.entries, { guildId, channelId }).muted;
  });
}

// ---- ações (a resposta já atualiza a tela; o evento do servidor sincroniza as outras abas) ----

function mutedUntil(choice: MuteChoice): string | undefined {
  return choice === "forever" ? undefined : new Date(Date.now() + choice * 60_000).toISOString();
}

/** Silencia (ou, com `null`, reativa) preservando o nível escolhido. */
export async function setMute(scope: Scope, id: string, choice: MuteChoice | null) {
  const cur = useNotificationSettings.getState().entries[keyOf(scope, id)];
  const level = cur?.level ?? undefined;
  const suppress = cur?.suppress_everyone ?? false;
  const res =
    choice === null && !level && !suppress
      ? await resetSetting(scope, id)
      : await putNotificationSetting(scope, id, {
          muted: choice !== null,
          muted_until: choice === null ? undefined : mutedUntil(choice),
          level,
          suppress_everyone: suppress,
        });
  if (res) useNotificationSettings.getState().apply(res);
}

/** Define o nível (ou `null` = herdar) preservando o silêncio vigente. */
export async function setLevel(scope: Scope, id: string, level: NotificationLevel | null) {
  const cur = useNotificationSettings.getState().entries[keyOf(scope, id)];
  const muted = isMutedEntry(cur);
  const suppress = cur?.suppress_everyone ?? false;
  const res =
    !muted && level === null && !suppress
      ? await resetSetting(scope, id)
      : await putNotificationSetting(scope, id, {
          muted,
          muted_until: muted ? (cur?.muted_until ?? undefined) : undefined,
          level: level ?? undefined,
          suppress_everyone: suppress,
        });
  if (res) useNotificationSettings.getState().apply(res);
}

/** Volta o alvo ao padrão. */
export async function resetSetting(scope: Scope, id: string) {
  await deleteNotificationSetting(scope, id);
  const empty: NotificationSettingPayload = {
    scope,
    target_id: id,
    muted: false,
    muted_until: null,
    level: null,
    suppress_everyone: false,
  };
  useNotificationSettings.getState().apply(empty);
  return empty;
}

/** "Suprimir @everyone e @here" do servidor: não soma menção nem avisa; menção a cargo e direta continuam. */
export async function setSuppressEveryone(guildId: string, suppress: boolean) {
  const cur = useNotificationSettings.getState().entries[keyOf("guild", guildId)];
  const muted = isMutedEntry(cur);
  const level = cur?.level ?? undefined;
  const res =
    !suppress && !muted && !level
      ? await resetSetting("guild", guildId)
      : await putNotificationSetting("guild", guildId, {
          muted,
          muted_until: muted ? (cur?.muted_until ?? undefined) : undefined,
          level,
          suppress_everyone: suppress,
        });
  if (res) useNotificationSettings.getState().apply(res);
}
