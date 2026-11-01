import { useGetMe } from "@spook/shared";
import { Link } from "@tanstack/react-router";
import { ChevronUp, Smile } from "lucide-react";
import { useState } from "react";
import { Avatar } from "@/components/avatar";
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
import { updatePresence } from "./actions";
import { CustomStatusDialog } from "./custom-status-dialog";
import { type DisplayStatus, useCustomStatus, usePresence } from "./store";

const CHOICES: { pref: "online" | "dnd" | "invisible"; status: DisplayStatus; hint: string }[] = [
  { pref: "online", status: "online", hint: "Ausente automático após 10 min parado" },
  { pref: "dnd", status: "dnd", hint: "Sem avisos, sons nem push" },
  { pref: "invisible", status: "invisible", hint: "Você aparece offline para os outros" },
];

/** Rodapé da barra lateral: perfil, seletor de status e status personalizado. */
export function UserPanel() {
  const { data: me } = useGetMe();
  const status = usePresence(me?.id);
  const custom = useCustomStatus(me?.id);
  const [editing, setEditing] = useState(false);
  if (!me) return null;
  const name = me.display_name || me.username;
  return (
    <VoiceDock>
      <VoiceCallCard />
      <div className="flex items-center gap-1 p-2">
        <Link
          to="/settings/profile"
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md p-1 hover:bg-accent"
          aria-label="Meu perfil"
        >
          <span className="relative inline-flex shrink-0">
            <Avatar url={me.avatar_url} name={name} size={32} />
            <PresenceDot status={status} size={10} className="absolute -right-0.5 -bottom-0.5" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{name}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {custom ? `${custom.emoji ?? ""} ${custom.text ?? ""}`.trim() : `@${me.username}`}
            </span>
          </span>
        </Link>
        <VoiceUserControls />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`Status: ${statusLabel[status]}. Mudar status`}
              className="flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-accent data-[state=open]:bg-accent"
            >
              <ChevronUp className="size-4" aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="w-64">
            <DropdownMenuLabel>Status</DropdownMenuLabel>
            {CHOICES.map((c) => (
              <DropdownMenuItem
                key={c.pref}
                onSelect={() => void updatePresence({ status_pref: c.pref })}
              >
                <PresenceDot status={c.status} size={10} className="ring-0" />
                <span className="flex min-w-0 flex-col">
                  <span>{c.pref === "online" ? "Online" : statusLabel[c.status]}</span>
                  <span className="text-xs text-muted-foreground">{c.hint}</span>
                </span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setEditing(true)}>
              <Smile /> {custom ? "Editar status personalizado" : "Definir status personalizado"}
            </DropdownMenuItem>
            {custom ? (
              <DropdownMenuItem onSelect={() => void updatePresence({ clear_custom_status: true })}>
                Limpar status personalizado
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
        <CustomStatusDialog open={editing} onOpenChange={setEditing} />
      </div>
    </VoiceDock>
  );
}
