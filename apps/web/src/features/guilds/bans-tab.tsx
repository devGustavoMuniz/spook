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
import { useT } from "@/i18n";
import { appMessage } from "@/lib/app-errors";
import { formatDateTime, formatRelative } from "@/lib/format";
import type { Guild } from "@/lib/guild";

const PAGE = 1000;

/** Banimentos do servidor: quem, motivo, quem baniu e quando; desbanir com confirmação (BAN_MEMBERS). */
export function BansTab({ guild }: { guild: Guild }) {
  const { t } = useT();
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
      toast.success(
        t("guilds.bans.unbanned", { name: shownName(target.display_name, target.username) }),
      );
    } catch (e) {
      toast.error(appMessage(e));
      await qc.invalidateQueries({ queryKey: list.queryKey });
    } finally {
      setTarget(null);
    }
  }

  return (
    <DialogBody className="gap-4">
      <p className="text-sm text-pretty text-muted-foreground">{t("guilds.bans.intro")}</p>
      <section aria-label={t("guilds.bans.section")} className="flex flex-col gap-2">
        {list.isPending ? (
          <output className="flex flex-col gap-2">
            <Skeleton className="h-16 w-full rounded-xl" />
            <Skeleton className="h-16 w-full rounded-xl" />
            <span className="sr-only">{t("guilds.common.loading")}</span>
          </output>
        ) : list.isError ? (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-3 rounded-xl border border-destructive/40 p-4 text-sm"
          >
            <span className="text-destructive-text">{appMessage(list.error)}</span>
            <Button size="sm" variant="outline" onClick={() => void list.refetch()}>
              {t("guilds.common.retry")}
            </Button>
          </div>
        ) : bans.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-4 py-8 text-center">
            <Gavel aria-hidden className="size-7 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{t("guilds.bans.empty")}</p>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {bans.map((b) => (
              <BanRow key={b.user_id} ban={b} onUnban={() => setTarget(b)} />
            ))}
          </ul>
        )}
        {list.data?.has_more ? (
          <p className="text-xs text-muted-foreground">
            {t("guilds.bans.showingFirst", { count: PAGE })}
          </p>
        ) : null}
      </section>
      <AlertDialog open={!!target} onOpenChange={(o) => !o && setTarget(null)}>
        <AlertDialogContent>
          <AlertDialogTitle>
            {t("guilds.bans.unbanTitle", {
              name: target ? shownName(target.display_name, target.username) : "",
            })}
          </AlertDialogTitle>
          <AlertDialogDescription>{t("guilds.bans.unbanBody")}</AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("guilds.common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirm()}>
              {t("guilds.bans.unban")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DialogBody>
  );
}

function BanRow({ ban, onUnban }: { ban: BanPayload; onUnban: () => void }) {
  const { t } = useT();
  const name = shownName(ban.display_name, ban.username);
  return (
    <li className="flex flex-col gap-3 rounded-xl border border-border bg-card p-3.5 shadow-xs sm:flex-row sm:items-center">
      <Avatar url={ban.avatar_url} name={name} seed={ban.user_id} size={40} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="truncate text-sm font-medium">
          {name} <span className="font-normal text-muted-foreground">@{ban.username}</span>
        </p>
        <p className="text-xs break-words text-muted-foreground">
          {ban.reason ? t("guilds.bans.reason", { reason: ban.reason }) : t("guilds.bans.noReason")}
        </p>
        <p className="text-xs text-muted-foreground">
          {ban.banned_by_username
            ? `${t("guilds.bans.by", { username: ban.banned_by_username })} · `
            : ""}
          <time dateTime={ban.created_at} title={formatDateTime(ban.created_at)}>
            {formatRelative(ban.created_at)}
          </time>
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        className="shrink-0"
        aria-label={t("guilds.bans.unbanAria", { name })}
        onClick={onUnban}
      >
        <Undo2 /> {t("guilds.bans.unban")}
      </Button>
    </li>
  );
}
