import {
  isApiError,
  type MemberPayload,
  useAddGuildMemberRole,
  useGetMe,
  useRemoveGuildMember,
  useRemoveGuildMemberRole,
} from "@spook/shared";
import { useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { StatusAvatar } from "@/components/presence-dot";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { useStartDm } from "@/features/dms/use-start-dm";
import { appMessage } from "@/lib/app-errors";
import { colorToHex } from "@/lib/colors";
import { canKick, canManageRole, type Guild, memberColor, rolesOf } from "@/lib/guild";
import { queryKeys } from "@/lib/queryKeys";
import { memberName, useGuildMembers } from "./use-members";

export function MembersPanel({ guild }: { guild: Guild }) {
  const { data: me } = useGetMe();
  const { startDm } = useStartDm();
  const members = useGuildMembers(guild.id);
  const [rolesFor, setRolesFor] = useState<MemberPayload | null>(null);
  const [kicking, setKicking] = useState<MemberPayload | null>(null);
  const list = members.data?.members ?? [];
  const canAssign = rolesOf(guild).some((r) => !r.is_everyone && canManageRole(guild, r));

  return (
    <aside
      aria-label="Membros"
      className="hidden w-60 shrink-0 flex-col border-l bg-sidebar lg:flex"
    >
      <h2 className="px-4 pt-4 pb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Membros{members.data ? ` — ${list.length}` : ""}
      </h2>
      <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {members.isPending ? (
          <li className="px-2 text-sm text-muted-foreground">Carregando…</li>
        ) : members.isError ? (
          <li className="px-2 text-sm text-destructive-text">{appMessage(members.error)}</li>
        ) : null}
        {list.map((m) => {
          const color = memberColor(guild, m);
          const mayKick = !!me && canKick(guild, m, me.id);
          const mayRoles = canAssign && m.user_id !== guild.owner_id;
          const roleNames = rolesOf(guild)
            .filter((r) => m.role_ids?.includes(r.id))
            .map((r) => r.name);
          return (
            <li
              key={m.user_id}
              className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent"
            >
              <StatusAvatar userId={m.user_id} url={m.avatar_url} name={memberName(m)} size={28} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm" style={color ? { color } : undefined}>
                  {memberName(m)}
                  {m.user_id === guild.owner_id ? (
                    <span className="ml-1 text-xs text-muted-foreground" title="Dono do servidor">
                      (dono)
                    </span>
                  ) : null}
                </p>
                {roleNames.length > 0 ? (
                  <p className="truncate text-[11px] text-muted-foreground">
                    {roleNames.join(", ")}
                  </p>
                ) : null}
              </div>
              {m.user_id !== me?.id ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
                      aria-label={`Opções de ${memberName(m)}`}
                    >
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => void startDm(m.user_id)}>
                      Enviar mensagem
                    </DropdownMenuItem>
                    {mayRoles ? (
                      <DropdownMenuItem onSelect={() => setRolesFor(m)}>
                        Gerenciar cargos
                      </DropdownMenuItem>
                    ) : null}
                    {mayKick ? (
                      <DropdownMenuItem destructive onSelect={() => setKicking(m)}>
                        Expulsar
                      </DropdownMenuItem>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </li>
          );
        })}
      </ul>
      {members.data?.has_more ? (
        <p className="px-4 pb-3 text-xs text-muted-foreground">Mostrando os primeiros membros.</p>
      ) : null}
      <MemberRolesDialog guild={guild} member={rolesFor} onClose={() => setRolesFor(null)} />
      <KickDialog guild={guild} member={kicking} onClose={() => setKicking(null)} />
    </aside>
  );
}

function KickDialog({
  guild,
  member,
  onClose,
}: {
  guild: Guild;
  member: MemberPayload | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const remove = useRemoveGuildMember();
  async function confirm() {
    if (!member) return;
    try {
      await remove.mutateAsync({ guildId: guild.id, userId: member.user_id });
      await qc.invalidateQueries({ queryKey: queryKeys.members(guild.id) });
      toast.success(`${memberName(member)} foi expulso.`);
    } catch (e) {
      toast.error(appMessage(e));
    } finally {
      onClose();
    }
  }
  return (
    <AlertDialog open={!!member} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogTitle>Expulsar {member ? memberName(member) : ""}?</AlertDialogTitle>
        <AlertDialogDescription>
          A pessoa perde o acesso ao servidor, mas pode voltar com um novo convite.
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancelar</AlertDialogCancel>
          <AlertDialogAction onClick={() => void confirm()}>Expulsar</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function MemberRolesDialog({
  guild,
  member,
  onClose,
}: {
  guild: Guild;
  member: MemberPayload | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const add = useAddGuildMemberRole();
  const remove = useRemoveGuildMemberRole();
  // Cargos do membro vêm do cache de membros (atualiza após cada troca).
  const members = useGuildMembers(guild.id);
  const current = members.data?.members?.find((m) => m.user_id === member?.user_id) ?? member;
  const has = new Set(current?.role_ids ?? []);

  async function toggle(roleId: string, on: boolean) {
    if (!member) return;
    try {
      const vars = { guildId: guild.id, userId: member.user_id, roleId };
      if (on) await add.mutateAsync(vars);
      else await remove.mutateAsync(vars);
      await qc.invalidateQueries({ queryKey: queryKeys.members(guild.id) });
    } catch (e) {
      toast.error(appMessage(e));
      if (isApiError(e) && e.status === 404)
        await qc.invalidateQueries({ queryKey: queryKeys.members(guild.id) });
    }
  }

  return (
    <Dialog open={!!member} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cargos de {member ? memberName(member) : ""}</DialogTitle>
          <DialogDescription>
            Você só pode dar ou tirar cargos abaixo do seu cargo mais alto.
          </DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col gap-1">
          {rolesOf(guild)
            .filter((r) => !r.is_everyone)
            .map((r) => {
              const allowed = canManageRole(guild, r);
              return (
                <li key={r.id} className="flex items-center gap-3 rounded-md px-2 py-1.5">
                  <span
                    aria-hidden
                    className="size-3 rounded-full border"
                    style={{ background: colorToHex(r.color) ?? "transparent" }}
                  />
                  <span id={`role-${r.id}`} className="min-w-0 flex-1 truncate text-sm">
                    {r.name}
                  </span>
                  <Switch
                    aria-labelledby={`role-${r.id}`}
                    checked={has.has(r.id)}
                    disabled={!allowed}
                    onCheckedChange={(on) => void toggle(r.id, on)}
                  />
                </li>
              );
            })}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
