import { Bell, BellOff } from "lucide-react";
import { toast } from "sonner";
import {
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { type MessageKey, useT } from "@/i18n";
import { appMessage } from "@/lib/app-errors";
import {
  defaultLevel,
  isMutedEntry,
  LEVEL_OPTIONS,
  MUTE_OPTIONS,
  type MuteChoice,
  type Scope,
  setLevel,
  setMute,
  setSuppressEveryone,
  useNotificationSettings,
  useSetting,
} from "./settings";

const INHERIT = "inherit";

/**
 * Itens de menu "Silenciar por…" e "Configurações de notificação" (tudo, só menções, nada) de um
 * servidor, canal ou DM. Vão dentro de um `DropdownMenuContent`. O alvo do texto ("o servidor", "este canal",
 * "esta conversa") sai de `scope` e `isGuildLike`.
 */
export function NotificationMenuItems({
  scope,
  targetId,
  isGuildLike,
  withSeparator = true,
}: {
  scope: Scope;
  targetId: string;
  /** @deprecated Ignorado: o texto do alvo vem de `scope` e `isGuildLike`. Pode ser removido dos chamadores. */
  what?: string;
  /** Servidor ou canal de servidor (padrão "só menções"); falso em DMs (padrão "tudo"). */
  isGuildLike: boolean;
  withSeparator?: boolean;
}) {
  const { t } = useT();
  const setting = useSetting(scope, targetId);
  const target: "guild" | "channel" | "dm" =
    scope === "guild" ? "guild" : isGuildLike ? "channel" : "dm";
  useNotificationSettings((s) => s.tick); // reavalia quando um silêncio vence
  const muted = isMutedEntry(setting);
  const level = setting?.level ?? INHERIT;

  async function run(action: () => Promise<void>) {
    try {
      await action();
    } catch (e) {
      toast.error(appMessage(e));
    }
  }

  return (
    <>
      {withSeparator ? <DropdownMenuSeparator /> : null}
      {muted ? (
        <DropdownMenuItem onSelect={() => void run(() => setMute(scope, targetId, null))}>
          <Bell /> {t(UNMUTE_KEY[target])}
        </DropdownMenuItem>
      ) : (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <BellOff /> {t(MUTE_KEY[target])}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {MUTE_OPTIONS.map((o) => (
              <DropdownMenuItem
                key={String(o.value)}
                onSelect={() => void run(() => setMute(scope, targetId, o.value as MuteChoice))}
              >
                {t(o.labelKey)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      )}
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <Bell /> {t("settings.notifMenu.settings")}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          <DropdownMenuRadioGroup
            value={level}
            onValueChange={(v) =>
              void run(() =>
                setLevel(
                  scope,
                  targetId,
                  v === INHERIT ? null : (v as "all" | "mentions" | "none"),
                ),
              )
            }
          >
            <DropdownMenuRadioItem value={INHERIT}>
              {scope === "channel" && isGuildLike
                ? t("settings.notifMenu.inherit")
                : t("settings.notifMenu.default", {
                    level: t(levelKey(defaultLevel(isGuildLike))).toLowerCase(),
                  })}
            </DropdownMenuRadioItem>
            {LEVEL_OPTIONS.map((o) => (
              <DropdownMenuRadioItem key={o.value} value={o.value}>
                {t(o.labelKey)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          {scope === "guild" ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem
                checked={setting?.suppress_everyone ?? false}
                onCheckedChange={(v) => void run(() => setSuppressEveryone(targetId, v === true))}
              >
                {t("settings.notifMenu.suppressEveryone")}
              </DropdownMenuCheckboxItem>
            </>
          ) : null}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </>
  );
}

const MUTE_KEY: Record<"guild" | "channel" | "dm", MessageKey> = {
  guild: "settings.notifMenu.muteGuild",
  channel: "settings.notifMenu.muteChannel",
  dm: "settings.notifMenu.muteDm",
};

const UNMUTE_KEY: Record<"guild" | "channel" | "dm", MessageKey> = {
  guild: "settings.notifMenu.unmuteGuild",
  channel: "settings.notifMenu.unmuteChannel",
  dm: "settings.notifMenu.unmuteDm",
};

function levelKey(level: "all" | "mentions" | "none"): MessageKey {
  return (LEVEL_OPTIONS.find((o) => o.value === level) ?? LEVEL_OPTIONS[0]).labelKey;
}
