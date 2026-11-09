import { Permission } from "@spook/shared";
import { UserPlus } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { VoiceInviteIllustration } from "@/components/illustrations";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
import { can, type Guild } from "@/lib/guild";
import { useStageHold } from "./use-idle-controls";

// O diálogo de convites é o das configurações do servidor (aba "Convites"), carregado sob demanda.
const GuildSettingsDialog = lazy(() =>
  import("@/features/guilds/settings-dialog").then((m) => ({ default: m.GuildSettingsDialog })),
);

/** Tile de convite: aparece ao lado do seu enquanto você está sozinho na chamada. */
export function InviteTile({ guild, width }: { guild: Guild; width?: number }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  useStageHold(open);
  const allowed = can(guild, Permission.CREATE_INVITE);
  return (
    <li
      data-testid="invite-tile"
      style={{ width }}
      className="relative flex aspect-video min-h-0 list-none flex-col items-center justify-center gap-2 overflow-hidden rounded-xl border-2 border-dashed border-border bg-card/60 p-3 text-center"
    >
      <VoiceInviteIllustration className="h-[38%] max-h-32 w-auto min-h-0" aria-hidden="true" />
      <div className="flex flex-col items-center gap-0.5">
        <p className="text-sm font-semibold">{t("voice.invite.title")}</p>
        <p className="text-xs text-muted-foreground text-pretty">{t("voice.invite.desc")}</p>
      </div>
      <Button
        size="sm"
        disabled={!allowed}
        title={allowed ? undefined : t("voice.invite.noPermission")}
        onClick={() => setOpen(true)}
      >
        <UserPlus /> {t("voice.invite.button")}
      </Button>
      {allowed ? null : (
        <p className="text-xs text-muted-foreground">{t("voice.invite.noPermission")}</p>
      )}
      {open ? (
        <Suspense fallback={null}>
          <GuildSettingsDialog guild={guild} initialTab="invites" onClose={() => setOpen(false)} />
        </Suspense>
      ) : null}
    </li>
  );
}
