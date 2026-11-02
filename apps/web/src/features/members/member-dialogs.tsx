import {
  isApiError,
  type MemberPayload,
  useAddGuildMemberRole,
  useRemoveGuildMember,
  useRemoveGuildMemberRole,
} from "@spook/shared";
import { useQueryClient } from "@tanstack/react-query";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { appMessage } from "@/lib/app-errors";
import { colorToHex } from "@/lib/colors";
import { canManageRole, type Guild, rolesOf } from "@/lib/guild";
import { queryKeys } from "@/lib/queryKeys";
import { memberName, useGuildMembers } from "./use-members";

export function KickDialog({
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

export function MemberRolesDialog({
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
