import { listMyTickets, type TicketPayload } from "@spook/shared";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Inbox } from "lucide-react";
import { ErrorState } from "@/components/state-screen";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SettingsGroup } from "@/features/settings/ui";
import { useT } from "@/i18n";
import { formatDateTime } from "@/lib/format";
import { kindKey, STATUS_VARIANT, statusKey } from "./labels";

const PAGE = 10;

/** Meus chamados, paginados por cursor. A chave começa por `/api/tickets`: o TICKET_UPDATE a invalida. */
export function useMyTickets() {
  return useInfiniteQuery({
    queryKey: ["/api/tickets", "mine", { limit: PAGE }],
    queryFn: ({ pageParam, signal }) =>
      listMyTickets({ limit: PAGE, ...(pageParam ? { cursor: pageParam } : {}) }, { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
}

export function TicketListCard({ onOpen }: { onOpen: (id: string) => void }) {
  const { t } = useT();
  const q = useMyTickets();
  const items = q.data?.pages.flatMap((p) => p.items ?? []) ?? [];
  return (
    <SettingsGroup
      icon={Inbox}
      title={t("feedback.list.title")}
      description={t("feedback.list.description")}
    >
      {q.isPending ? (
        <Skeleton className="h-14 w-full" />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("feedback.list.empty")}</p>
      ) : (
        <>
          <ul aria-label={t("feedback.list.title")} className="flex flex-col gap-1.5">
            {items.map((tk) => (
              <li key={tk.id}>
                <TicketRow ticket={tk} onOpen={onOpen} />
              </li>
            ))}
          </ul>
          {q.hasNextPage ? (
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              loading={q.isFetchingNextPage}
              onClick={() => void q.fetchNextPage()}
            >
              {t("feedback.list.loadMore")}
            </Button>
          ) : null}
        </>
      )}
    </SettingsGroup>
  );
}

function TicketRow({ ticket, onOpen }: { ticket: TicketPayload; onOpen: (id: string) => void }) {
  const { t } = useT();
  return (
    <button
      type="button"
      onClick={() => onOpen(ticket.id)}
      className="flex w-full flex-col gap-1.5 rounded-lg border border-border bg-surface-1 px-3 py-2.5 text-left transition-colors hover:border-brand-400 hover:bg-accent/40"
    >
      <span className="flex items-start justify-between gap-3">
        <span className="min-w-0 truncate text-sm font-medium">{ticket.title}</span>
        {ticket.unread ? (
          <Badge variant="destructive" className="shrink-0">
            {t("feedback.list.newReply")}
          </Badge>
        ) : null}
      </span>
      <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant={STATUS_VARIANT[ticket.status]}>{t(statusKey(ticket.status))}</Badge>
        <span>{t(kindKey(ticket.kind))}</span>
        <span aria-hidden>·</span>
        <span>{t("feedback.list.messages", { count: ticket.message_count })}</span>
        <span aria-hidden>·</span>
        <span>{t("feedback.list.updated", { when: formatDateTime(ticket.last_activity_at) })}</span>
      </span>
    </button>
  );
}
