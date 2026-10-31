import { Permission, useRemoveGuildMember } from "@spook/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDown, LogOut, Plus, Settings, Shield, UserPlus } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { NotificationMenuItems } from "@/features/notifications/notification-menu";
import { appMessage } from "@/lib/app-errors";
import { can, type Guild } from "@/lib/guild";
import { removeGuild } from "@/lib/guild-cache";
import type { SettingsTab } from "./settings-dialog";

// Configurações carregam sob demanda: formulários de cargos/convites não entram no bundle inicial.
const GuildSettingsDialog = lazy(() =>
  import("./settings-dialog").then((m) => ({ default: m.GuildSettingsDialog })),
);

export function GuildMenu({
  guild,
  onCreateChannel,
}: {
  guild: Guild;
  onCreateChannel: () => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const leave = useRemoveGuildMember();
  const [tab, setTab] = useState<SettingsTab | null>(null);
  const [leaving, setLeaving] = useState(false);

  const canInvite = can(guild, Permission.CREATE_INVITE);
  const canSettings = can(guild, Permission.MANAGE_GUILD);
  const canRoles = can(guild, Permission.MANAGE_ROLES);
  const canChannels = can(guild, Permission.MANAGE_CHANNELS);

  async function confirmLeave() {
    try {
      await leave.mutateAsync({ guildId: guild.id, userId: "@me" });
      removeGuild(qc, guild.id);
      await navigate({ to: "/" });
    } catch (e) {
      toast.error(appMessage(e));
    } finally {
      setLeaving(false);
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Menu do servidor ${guild.name}`}
            className="flex h-12 w-full items-center justify-between gap-2 border-b px-4 text-left font-semibold hover:bg-accent data-[state=open]:bg-accent"
          >
            <span className="truncate">{guild.name}</span>
            <ChevronDown className="size-4 shrink-0" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          {canInvite ? (
            <DropdownMenuItem onSelect={() => setTab("invites")}>
              <UserPlus /> Convidar pessoas
            </DropdownMenuItem>
          ) : null}
          {canSettings ? (
            <DropdownMenuItem onSelect={() => setTab("general")}>
              <Settings /> Configurações do servidor
            </DropdownMenuItem>
          ) : null}
          {canRoles ? (
            <DropdownMenuItem onSelect={() => setTab("roles")}>
              <Shield /> Cargos
            </DropdownMenuItem>
          ) : null}
          {canChannels ? (
            <DropdownMenuItem onSelect={onCreateChannel}>
              <Plus /> Criar canal
            </DropdownMenuItem>
          ) : null}
          <NotificationMenuItems
            scope="guild"
            targetId={guild.id}
            what="o servidor"
            isGuildLike
            withSeparator={canInvite || canSettings || canRoles || canChannels}
          />
          {!guild.is_owner ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive onSelect={() => setLeaving(true)}>
                <LogOut /> Sair do servidor
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {tab ? (
        <Suspense fallback={null}>
          <GuildSettingsDialog guild={guild} initialTab={tab} onClose={() => setTab(null)} />
        </Suspense>
      ) : null}
      <AlertDialog open={leaving} onOpenChange={setLeaving}>
        <AlertDialogContent>
          <AlertDialogTitle>Sair de {guild.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Para voltar, você vai precisar de um novo convite.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmLeave()}>Sair</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
