import { type AuditEntryPayload, listAuditLogs, type MemberPayload } from "@spook/shared";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ScrollText } from "lucide-react";
import { useId, useState } from "react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { DialogBody } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { shownName } from "@/features/account/removed-user";
import { memberName, useGuildMembers } from "@/features/members/use-members";
import { useT } from "@/i18n";
import { appMessage } from "@/lib/app-errors";
import { formatFullDate, formatRelative } from "@/lib/format";
import type { Guild } from "@/lib/guild";
import { AUDIT_ACTIONS, auditSentence } from "./audit-text";

const ALL = "all";
const PAGE = 30;

/** Registro de auditoria (VIEW_AUDIT_LOG): quem fez o quê, com filtros por ação e autor e "Carregar mais". */
export function AuditTab({ guild }: { guild: Guild }) {
  const { t, locale } = useT();
  const [action, setAction] = useState(ALL);
  const [actor, setActor] = useState(ALL);
  const members = useGuildMembers(guild.id);
  const id = useId();
  const q = useInfiniteQuery({
    queryKey: ["audit-logs", guild.id, action, actor],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      listAuditLogs(
        guild.id,
        {
          limit: PAGE,
          ...(action !== ALL ? { action } : {}),
          ...(actor !== ALL ? { actor } : {}),
          ...(pageParam ? { before: pageParam } : {}),
        },
        { signal },
      ),
    getNextPageParam: (last) =>
      last.has_more ? last.entries?.[last.entries.length - 1]?.id : undefined,
  });
  const entries = q.data?.pages.flatMap((p) => p.entries ?? []) ?? [];
  const people = [...(members.data?.members ?? [])].sort((a: MemberPayload, b: MemberPayload) =>
    memberName(a).localeCompare(memberName(b), locale),
  );

  return (
    <DialogBody className="gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-action`}>{t("guilds.audit.action")}</Label>
          <Select value={action} onValueChange={setAction}>
            <SelectTrigger id={`${id}-action`} aria-label={t("guilds.audit.filterAction")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t("guilds.audit.allActions")}</SelectItem>
              {AUDIT_ACTIONS.map((a) => (
                <SelectItem key={a.value} value={a.value}>
                  {t(a.labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-actor`}>{t("guilds.audit.actor")}</Label>
          <Select value={actor} onValueChange={setActor}>
            <SelectTrigger id={`${id}-actor`} aria-label={t("guilds.audit.filterActor")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t("guilds.audit.allPeople")}</SelectItem>
              {people.map((m) => (
                <SelectItem key={m.user_id} value={m.user_id}>
                  {memberName(m)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <section aria-label={t("guilds.audit.section")} className="flex flex-col gap-2">
        {q.isPending ? (
          <output className="flex flex-col gap-2">
            <Skeleton className="h-14 w-full rounded-xl" />
            <Skeleton className="h-14 w-full rounded-xl" />
            <Skeleton className="h-14 w-full rounded-xl" />
            <span className="sr-only">{t("guilds.common.loading")}</span>
          </output>
        ) : q.isError ? (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-3 rounded-xl border border-destructive/40 p-4 text-sm"
          >
            <span className="text-destructive-text">{appMessage(q.error)}</span>
            <Button size="sm" variant="outline" onClick={() => void q.refetch()}>
              {t("guilds.common.retry")}
            </Button>
          </div>
        ) : entries.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-4 py-8 text-center">
            <ScrollText aria-hidden className="size-7 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              {action !== ALL || actor !== ALL
                ? t("guilds.audit.noMatch")
                : t("guilds.audit.empty")}
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {entries.map((e) => (
              <AuditRow key={e.id} entry={e} />
            ))}
          </ul>
        )}
        {q.hasNextPage ? (
          <Button
            variant="outline"
            size="sm"
            className="self-center"
            loading={q.isFetchingNextPage}
            onClick={() => void q.fetchNextPage()}
          >
            {t("guilds.audit.loadMore")}
          </Button>
        ) : null}
      </section>
    </DialogBody>
  );
}

function AuditRow({ entry }: { entry: AuditEntryPayload }) {
  const { t } = useT();
  const who = entry.actor
    ? shownName(entry.actor.display_name, entry.actor.username)
    : t("guilds.audit.deletedAccount");
  return (
    <li className="flex items-start gap-3 rounded-xl border border-border bg-card p-3 shadow-xs">
      <Avatar
        url={entry.actor?.avatar_url}
        name={who}
        seed={entry.actor?.id ?? entry.id}
        size={32}
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm break-words">
          <span className="font-medium">{who}</span> {auditSentence(entry, t)}
        </p>
        {entry.reason ? (
          <p className="mt-0.5 text-xs break-words text-muted-foreground">
            {t("guilds.audit.reason", { reason: entry.reason })}
          </p>
        ) : null}
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <time
            dateTime={entry.created_at}
            // Focável para a dica de hora completa aparecer também pelo teclado.
            // biome-ignore lint/a11y/noNoninteractiveTabindex: dica de hora acessível por teclado
            tabIndex={0}
            className="shrink-0 rounded text-xs text-muted-foreground"
          >
            {formatRelative(entry.created_at)}
          </time>
        </TooltipTrigger>
        <TooltipContent>{formatFullDate(entry.created_at)}</TooltipContent>
      </Tooltip>
    </li>
  );
}
