import { Bell, BellOff } from "lucide-react";
import { toast } from "sonner";
import {
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
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
  useNotificationSettings,
  useSetting,
} from "./settings";

const INHERIT = "inherit";

/**
 * Itens de menu "Silenciar por…" e "Configurações de notificação" (tudo, só menções, nada) de um
 * servidor, canal ou DM. Vão dentro de um `DropdownMenuContent`. `what` completa o texto ("o servidor",
 * "este canal", "esta conversa").
 */
export function NotificationMenuItems({
  scope,
  targetId,
  what,
  isGuildLike,
  withSeparator = true,
}: {
  scope: Scope;
  targetId: string;
  what: string;
  /** Servidor ou canal de servidor (padrão "só menções"); falso em DMs (padrão "tudo"). */
  isGuildLike: boolean;
  withSeparator?: boolean;
}) {
  const setting = useSetting(scope, targetId);
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
          <Bell /> Reativar {what}
        </DropdownMenuItem>
      ) : (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <BellOff /> Silenciar {what}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {MUTE_OPTIONS.map((o) => (
              <DropdownMenuItem
                key={String(o.value)}
                onSelect={() => void run(() => setMute(scope, targetId, o.value as MuteChoice))}
              >
                {o.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      )}
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <Bell /> Configurações de notificação
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
                ? "Herdar do servidor"
                : `Padrão (${levelName(defaultLevel(isGuildLike))})`}
            </DropdownMenuRadioItem>
            {LEVEL_OPTIONS.map((o) => (
              <DropdownMenuRadioItem key={o.value} value={o.value}>
                {o.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </>
  );
}

function levelName(level: "all" | "mentions" | "none") {
  return LEVEL_OPTIONS.find((o) => o.value === level)?.label.toLowerCase() ?? level;
}
