import { useGetMe, useListGuilds } from "@spook/shared";
import { BellOff } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { dmTitle } from "@/features/dms/dm-utils";
import { useDms } from "@/features/dms/use-dms";
import { SettingsGroup } from "@/features/settings/ui";
import { appMessage } from "@/lib/app-errors";
import {
  defaultLevel,
  isMutedEntry,
  LEVEL_OPTIONS,
  resetSetting,
  useNotificationSettings,
} from "./settings";

const levelLabel = (l: string) => LEVEL_OPTIONS.find((o) => o.value === l)?.label ?? l;

function mutedText(until: string | null) {
  if (!until) return "silenciado até você reativar";
  return `silenciado até ${new Date(until).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}`;
}

/**
 * Padrões de notificação e o que foi personalizado: servidores (só menções) e conversas diretas (tudo)
 * seguem o padrão até alguém mudar no menu do servidor, canal ou conversa. Silêncios e níveis também
 * podem ser desfeitos aqui.
 */
export function NotificationDefaultsCard() {
  const entries = useNotificationSettings((s) => s.entries);
  useNotificationSettings((s) => s.tick);
  const guilds = useListGuilds();
  const dms = useDms();
  const { data: me } = useGetMe();

  const nameOf = (scope: string, id: string): string => {
    if (scope === "guild") return guilds.data?.find((g) => g.id === id)?.name ?? "Servidor";
    const dm = dms.list.find((c) => c.id === id);
    if (dm) return me ? dmTitle(dm, me.id) : "Conversa";
    for (const g of guilds.data ?? []) {
      const ch = g.channels?.find((c) => c.id === id);
      if (ch) return `#${ch.name} · ${g.name}`;
    }
    return "Canal";
  };

  const rows = Object.values(entries)
    .filter((e) => isMutedEntry(e) || e.level)
    .sort((a, b) => nameOf(a.scope, a.target_id).localeCompare(nameOf(b.scope, b.target_id)));

  return (
    <SettingsGroup
      icon={BellOff}
      title="Silenciados e níveis"
      description={`Padrão dos servidores: ${levelLabel(defaultLevel(true)).toLowerCase()}. Padrão das conversas diretas: ${levelLabel(defaultLevel(false)).toLowerCase()}. Para mudar, abra o menu do servidor, do canal ou da conversa. Silenciar e o nível só mudam os avisos: as contagens de não lidas e menções continuam aparecendo.`}
    >
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nada personalizado por enquanto.</p>
      ) : (
        <ul className="flex flex-col divide-y">
          {rows.map((e) => (
            <li key={`${e.scope}:${e.target_id}`} className="flex items-center gap-3 py-2">
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium">{nameOf(e.scope, e.target_id)}</span>
                <span className="text-xs text-muted-foreground">
                  {[
                    isMutedEntry(e) ? mutedText(e.muted_until) : null,
                    e.level ? levelLabel(e.level) : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  void resetSetting(e.scope, e.target_id).catch((err) =>
                    toast.error(appMessage(err)),
                  )
                }
              >
                Restaurar padrão
              </Button>
            </li>
          ))}
        </ul>
      )}
    </SettingsGroup>
  );
}
