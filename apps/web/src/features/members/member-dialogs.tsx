import {
  isApiError,
  type MemberPayload,
  useAddGuildMemberRole,
  useBanGuildMember,
  useRemoveGuildMember,
  useRemoveGuildMemberRole,
  useSetGuildMemberNickname,
} from "@spook/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Lock, Pencil, Shield } from "lucide-react";
import { useState } from "react";
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
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogHead,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
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

export const NICK_MAX = 32;
export const BAN_REASON_MAX = 512;

/**
 * Banir com motivo opcional. Banir remove a pessoa e impede a volta por convite até desbanir (a lista fica em
 * Configurações do servidor > Banimentos). Serve também para quem já saiu: basta o ID.
 */
export function BanDialog({
  guild,
  member,
  onClose,
}: {
  guild: Guild;
  member: MemberPayload | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const ban = useBanGuildMember();
  const [reason, setReason] = useState("");
  const [lastId, setLastId] = useState<string>();
  // Cada alvo começa com o motivo em branco.
  if (member && member.user_id !== lastId) {
    setLastId(member.user_id);
    setReason("");
  }
  async function confirm() {
    if (!member) return;
    try {
      await ban.mutateAsync({
        guildId: guild.id,
        userId: member.user_id,
        data: reason.trim() ? { reason: reason.trim() } : {},
      });
      await qc.invalidateQueries({ queryKey: queryKeys.members(guild.id) });
      toast.success(`${memberName(member)} foi banido.`);
    } catch (e) {
      toast.error(appMessage(e));
    } finally {
      onClose();
    }
  }
  return (
    <AlertDialog open={!!member} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogTitle>Banir {member ? memberName(member) : ""}?</AlertDialogTitle>
        <AlertDialogDescription>
          A pessoa perde o acesso e não consegue voltar por convite enquanto estiver banida. Você
          pode desbanir em Configurações do servidor.
        </AlertDialogDescription>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ban-reason">Motivo (opcional)</Label>
          <Textarea
            id="ban-reason"
            value={reason}
            maxLength={BAN_REASON_MAX}
            rows={3}
            placeholder="Fica no registro de auditoria e na lista de banidos"
            onChange={(e) => setReason(e.target.value)}
          />
          <p className="text-xs text-muted-foreground tabular">
            {reason.length}/{BAN_REASON_MAX}
          </p>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancelar</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={() => void confirm()}
          >
            Banir
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Alterar o apelido neste servidor (o próprio ou, com MANAGE_NICKNAMES, o de outro). Vazio remove. */
export function NicknameDialog({
  guild,
  member,
  self,
  onClose,
}: {
  guild: Guild;
  member: MemberPayload | null;
  self: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const set = useSetGuildMemberNickname();
  const [nick, setNick] = useState("");
  const [lastId, setLastId] = useState<string>();
  if (member && member.user_id !== lastId) {
    setLastId(member.user_id);
    setNick(member.nickname ?? "");
  }
  const tooLong = [...nick.trim()].length > NICK_MAX;
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!member || tooLong) return;
    try {
      await set.mutateAsync({
        guildId: guild.id,
        userId: self ? "@me" : member.user_id,
        data: { nick: nick.trim() || null },
      });
      await qc.invalidateQueries({ queryKey: queryKeys.members(guild.id) });
      toast.success(nick.trim() ? "Apelido alterado." : "Apelido removido.");
      onClose();
    } catch (err) {
      toast.error(appMessage(err));
    }
  }
  return (
    <Dialog open={!!member} onOpenChange={(o) => !o && onClose()}>
      <DialogContent flush size="sm">
        <DialogHead
          icon={Pencil}
          title={self ? "Alterar meu apelido" : `Apelido de ${member ? memberName(member) : ""}`}
          description={`Vale só em ${guild.name}. Deixe em branco para voltar ao nome de exibição.`}
        />
        <form onSubmit={(e) => void save(e)} noValidate className="flex min-h-0 flex-1 flex-col">
          <DialogBody>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="nick-input">Apelido</Label>
              <Input
                id="nick-input"
                autoFocus
                value={nick}
                maxLength={NICK_MAX * 4}
                aria-invalid={tooLong}
                aria-describedby="nick-hint"
                placeholder={member?.display_name || member?.username}
                onChange={(e) => setNick(e.target.value)}
              />
              <p
                id="nick-hint"
                className={`text-xs tabular ${tooLong ? "text-destructive-text" : "text-muted-foreground"}`}
              >
                {[...nick.trim()].length}/{NICK_MAX} caracteres
              </p>
            </div>
          </DialogBody>
          <DialogActions>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" loading={set.isPending} disabled={tooLong}>
              Salvar
            </Button>
          </DialogActions>
        </form>
      </DialogContent>
    </Dialog>
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

  const assignable = rolesOf(guild).filter((r) => !r.is_everyone);
  return (
    <Dialog open={!!member} onOpenChange={(o) => !o && onClose()}>
      <DialogContent flush size="sm" className="max-h-[min(34rem,90svh)]">
        <DialogHead
          icon={Shield}
          title={`Cargos de ${member ? memberName(member) : ""}`}
          description="Você só pode dar ou tirar cargos abaixo do seu cargo mais alto."
        />
        <DialogBody className="gap-0 py-2">
          {assignable.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Este servidor ainda não tem cargos. Crie um em Configurações do servidor.
            </p>
          ) : (
            <ul className="flex flex-col">
              {assignable.map((r) => {
                const allowed = canManageRole(guild, r);
                return (
                  <li
                    key={r.id}
                    className="flex min-h-12 items-center gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-accent/50"
                  >
                    <span
                      aria-hidden
                      className="size-3.5 shrink-0 rounded-full border border-border"
                      style={{ background: colorToHex(r.color) ?? "transparent" }}
                    />
                    <span id={`role-${r.id}`} className="min-w-0 flex-1 truncate text-sm">
                      {r.name}
                    </span>
                    {!allowed ? (
                      <Lock
                        className="size-3.5 shrink-0 text-muted-foreground"
                        aria-label="Acima do seu cargo"
                        role="img"
                      />
                    ) : null}
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
          )}
        </DialogBody>
        <DialogActions>
          <DialogClose asChild>
            <Button>Concluído</Button>
          </DialogClose>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}
