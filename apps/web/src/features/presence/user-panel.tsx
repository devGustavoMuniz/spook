import { useGetMe } from "@spook/shared";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronUp, Settings, Smile, UserRound } from "lucide-react";
import { useState } from "react";
import { Avatar } from "@/components/avatar";
import { LanguageMenuItems } from "@/components/language-menu";
import { PresenceDot, statusLabel } from "@/components/presence-dot";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { VoiceCallCard, VoiceDock, VoiceUserControls } from "@/features/voice/voice-bar";
import { type MessageKey, useT } from "@/i18n";
import { updatePresence } from "./actions";
import { CustomStatusDialog } from "./custom-status-dialog";
import { type DisplayStatus, useCustomStatus, usePresence } from "./store";

const CHOICES: {
  pref: "online" | "dnd" | "invisible";
  status: DisplayStatus;
  hintKey: MessageKey;
}[] = [
  { pref: "online", status: "online", hintKey: "settings.presence.onlineHint" },
  { pref: "dnd", status: "dnd", hintKey: "settings.presence.dndHint" },
  { pref: "invisible", status: "invisible", hintKey: "settings.presence.invisibleHint" },
];

/** Rodapé da barra lateral: perfil, seletor de status e status personalizado. */
export function UserPanel() {
  const { t } = useT();
  const { data: me } = useGetMe();
  const status = usePresence(me?.id);
  const custom = useCustomStatus(me?.id);
  const [editing, setEditing] = useState(false);
  const navigate = useNavigate();
  if (!me) return null;
  const name = me.display_name || me.username;
  return (
    <VoiceDock>
      <VoiceCallCard />
      <div className="flex items-center p-1.5">
        <Link
          to="/settings/profile"
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg p-1 transition-colors hover:bg-accent"
          aria-label={t("settings.presence.myProfile")}
        >
          <span className="relative inline-flex shrink-0">
            <Avatar url={me.avatar_url} name={name} size={32} />
            <PresenceDot
              status={status}
              size={11}
              className="absolute -right-0.5 -bottom-0.5 ring-[3px] ring-surface-1"
            />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm leading-tight font-semibold">{name}</span>
            <span className="block truncate text-xs leading-tight text-muted-foreground">
              {custom ? `${custom.emoji ?? ""} ${custom.text ?? ""}`.trim() : `@${me.username}`}
            </span>
          </span>
        </Link>
        <VoiceUserControls />
        <Link
          to="/settings/profile"
          aria-label={t("settings.presence.userSettings")}
          title={t("settings.presence.userSettings")}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Settings className="size-4" aria-hidden />
        </Link>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t("settings.presence.changeStatus", { status: statusLabel[status] })}
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-[state=open]:bg-accent"
            >
              <ChevronUp className="size-4" aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="w-64">
            <DropdownMenuLabel>{t("settings.presence.status")}</DropdownMenuLabel>
            {CHOICES.map((c) => (
              <DropdownMenuItem
                key={c.pref}
                onSelect={() => void updatePresence({ status_pref: c.pref })}
              >
                <PresenceDot status={c.status} size={10} className="ring-0" />
                <span className="flex min-w-0 flex-col">
                  <span>
                    {c.pref === "online" ? t("settings.presence.online") : statusLabel[c.status]}
                  </span>
                  <span className="text-xs text-muted-foreground">{t(c.hintKey)}</span>
                </span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setEditing(true)}>
              <Smile />{" "}
              {custom ? t("settings.presence.editCustom") : t("settings.presence.setCustom")}
            </DropdownMenuItem>
            {custom ? (
              <DropdownMenuItem onSelect={() => void updatePresence({ clear_custom_status: true })}>
                {t("settings.presence.clearCustom")}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void navigate({ to: "/settings/profile" })}>
              <UserRound /> {t("settings.presence.myProfile")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void navigate({ to: "/settings" })}>
              <Settings /> {t("settings.presence.settings")}
            </DropdownMenuItem>
            <LanguageMenuItems />
          </DropdownMenuContent>
        </DropdownMenu>
        <CustomStatusDialog open={editing} onOpenChange={setEditing} />
      </div>
    </VoiceDock>
  );
}
