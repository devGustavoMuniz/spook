import { type BanPayload, useListGuildBans, useUnbanGuildMember } from "@spook/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Gavel, Undo2 } from "lucide-react";
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
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { DialogBody } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { shownName } from "@/features/account/removed-user";
import { appMessage } from "@/lib/app-errors";
import { formatDateTime, formatRelative } from "@/lib/format";
import type { Guild } from "@/lib/guild";

const PAGE = 1000;

/** Banimentos do servidor: quem, motivo, quem baniu e quando; desbanir com confirmação (BAN_MEMBERS). */
export function BansTab({ guild }: { guild: Guild }) {
  const qc = useQueryClient();
  const list = useListGuildBans(guild.id, { limit: PAGE });
  const unban = useUnbanGuildMember();
  const [target, setTarget] = useState<BanPayload | null>(null);
  const bans = list.data?.bans ?? [];

  async function confirm() {
    if (!target) return;
    try {
      await unban.mutateAsync({ guildId: guild.id, userId: target.user_id });
      await qc.invalidateQueries({ queryKey: list.queryKey });
      toast.success(`${shownName(target.display_name, target.username)} foi desbanido.`);
    } catch (e) {
      toast.error(appMessage(e));
      await qc.invalidateQueries({ queryKey: list.queryKey });
    } finally {
      setTarget(null);
    }
  }

  return (
    <DialogBody className="gap-4">
      <p className="text-sm text-pretty text-muted-foreground">
        Quem está banido não entra por convite. Desbanir não traz a pessoa de volta: ela precisa de
        um novo convite.
      </p>
      <section aria-label="Banimentos" className="flex flex-col gap-2">
        {list.isPending ? (
          <output className="flex flex-col gap-2">
            <Skeleton className="h-16 w-full rounded-xl" />
            <Skeleton className="h-16 w-full rounded-xl" />
            <span className="sr-only">Carregando…</span>
          </output>
        ) : list.isError ? (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-3 rounded-xl border border-destructive/40 p-4 text-sm"
          >
            <span className="text-destructive-text">{appMessage(list.error)}</span>
            <Button size="sm" variant="outline" onClick={() => void list.refetch()}>
              Tentar de novo
            </Button>
          </div>
        ) : bans.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-4 py-8 text-center">
            <Gavel aria-hidden className="size-7 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Ninguém está banido deste servidor.</p>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {bans.map((b) => (
              <BanRow key={b.user_id} ban={b} onUnban={() => setTarget(b)} />
            ))}
          </ul>
        )}
        {list.data?.has_more ? (
          <p className="text-xs text-muted-foreground">Mostrando os primeiros {PAGE} banimentos.</p>
        ) : null}
      </section>
      <AlertDialog open={!!target} onOpenChange={(o) => !o && setTarget(null)}>
        <AlertDialogContent>
          <AlertDialogTitle>
            Desbanir {target ? shownName(target.display_name, target.username) : ""}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            A pessoa poderá entrar de novo com um convite. O banimento sai do histórico, mas o
            registro de auditoria continua.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirm()}>Desbanir</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DialogBody>
  );
}

function BanRow({ ban, onUnban }: { ban: BanPayload; onUnban: () => void }) {
  const name = shownName(ban.display_name, ban.username);
  return (
    <li className="flex flex-col gap-3 rounded-xl border border-border bg-card p-3.5 shadow-xs sm:flex-row sm:items-center">
      <Avatar url={ban.avatar_url} name={name} seed={ban.user_id} size={40} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="truncate text-sm font-medium">
          {name} <span className="font-normal text-muted-foreground">@{ban.username}</span>
        </p>
        <p className="text-xs break-words text-muted-foreground">
          {ban.reason ? <>Motivo: {ban.reason}</> : "Sem motivo informado."}
        </p>
        <p className="text-xs text-muted-foreground">
          {ban.banned_by_username ? `Por @${ban.banned_by_username} · ` : ""}
          <time dateTime={ban.created_at} title={formatDateTime(ban.created_at)}>
            {formatRelative(ban.created_at)}
          </time>
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        className="shrink-0"
        aria-label={`Desbanir ${name}`}
        onClick={onUnban}
      >
        <Undo2 /> Desbanir
      </Button>
    </li>
  );
}
