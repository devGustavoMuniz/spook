import { zodResolver } from "@hookform/resolvers/zod";
import {
  getGetMyTicketQueryKey,
  type TicketMessagePayload,
  useGetMyTicket,
  useReplyMyTicket,
  useSetMyTicketStatus,
} from "@spook/shared";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Lock, LockOpen } from "lucide-react";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { ErrorState } from "@/components/state-screen";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/i18n";
import { messageFor } from "@/lib/errors";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { kindKey, STATUS_VARIANT, statusKey } from "./labels";
import { ContextRows } from "./new-ticket-form";
import { BODY_MAX, type ReplyForm, replySchema } from "./schema";

/** Conversa de um chamado: abrir marca como lido (o servidor faz); responder, fechar e reabrir. */
export function TicketThread({ id, onBack }: { id: string; onBack: () => void }) {
  const { t } = useT();
  const qc = useQueryClient();
  const q = useGetMyTicket(id);
  const reply = useReplyMyTicket();
  const setStatus = useSetMyTicketStatus();
  const {
    register,
    handleSubmit,
    reset,
    watch,
    formState: { errors },
  } = useForm<ReplyForm>({ resolver: zodResolver(replySchema), defaultValues: { body: "" } });
  const length = [...(watch("body") ?? "")].length;

  // Abrir marcou o chamado como lido no servidor: a lista (selo "Nova resposta") precisa refletir isso.
  const ticketId = q.data?.id;
  const wasUnread = q.data?.unread;
  // biome-ignore lint/correctness/useExhaustiveDependencies: só quando o chamado carrega
  useEffect(() => {
    if (ticketId) void qc.invalidateQueries({ queryKey: ["/api/tickets", "mine"] });
  }, [ticketId]);

  async function refresh() {
    await qc.invalidateQueries({ queryKey: getGetMyTicketQueryKey(id) });
    await qc.invalidateQueries({ queryKey: ["/api/tickets", "mine"] });
  }

  const send = handleSubmit(async ({ body }) => {
    try {
      await reply.mutateAsync({ id, data: { body } });
      reset();
      toast.success(t("feedback.thread.replySent"));
      await refresh();
    } catch (e) {
      toast.error(messageFor(e));
    }
  });

  async function change(status: "open" | "closed") {
    try {
      await setStatus.mutateAsync({ id, data: { status } });
      toast.success(t(status === "closed" ? "feedback.thread.closed" : "feedback.thread.reopened"));
      await refresh();
    } catch (e) {
      toast.error(messageFor(e));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Button variant="ghost" size="sm" className="self-start" onClick={onBack}>
        <ArrowLeft aria-hidden /> {t("feedback.thread.back")}
      </Button>
      {q.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : (
        <>
          <header className="flex flex-col gap-2">
            <h2 className="text-lg font-semibold text-balance">{q.data.title}</h2>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant={STATUS_VARIANT[q.data.status]}>{t(statusKey(q.data.status))}</Badge>
              <span>{t(kindKey(q.data.kind))}</span>
              <span aria-hidden>·</span>
              <span>{formatDateTime(q.data.created_at)}</span>
              {wasUnread ? <span className="sr-only">{t("feedback.list.newReply")}</span> : null}
            </div>
          </header>
          <ol aria-label={t("feedback.list.title")} className="flex flex-col gap-3">
            {(q.data.messages ?? []).map((m) => (
              <MessageBubble key={m.id} message={m} />
            ))}
          </ol>
          {q.data.context ? (
            <details className="rounded-lg border border-border p-3 text-xs text-muted-foreground">
              <summary className="cursor-pointer font-medium">
                {t("feedback.thread.context")}
              </summary>
              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                <ContextRows context={{ ...q.data.context }} />
              </dl>
            </details>
          ) : null}
          {q.data.status === "closed" ? (
            <p className="text-sm text-muted-foreground">{t("feedback.thread.closedHint")}</p>
          ) : (
            <form onSubmit={send} noValidate className="flex flex-col gap-2">
              <label htmlFor="ticket-reply" className="text-sm font-medium">
                {t("feedback.thread.reply")}
              </label>
              <Textarea
                id="ticket-reply"
                rows={4}
                maxLength={BODY_MAX}
                placeholder={t("feedback.thread.replyPlaceholder")}
                aria-invalid={!!errors.body}
                aria-describedby={errors.body ? "ticket-reply-error" : undefined}
                {...register("body")}
              />
              <div className="flex items-center justify-between gap-2">
                {errors.body ? (
                  <p id="ticket-reply-error" role="alert" className="text-xs text-destructive-text">
                    {errors.body.message}
                  </p>
                ) : (
                  <span />
                )}
                <span className="text-xs text-muted-foreground" aria-live="off">
                  {`${length}/${BODY_MAX}`}
                </span>
              </div>
              <Button type="submit" className="self-start" loading={reply.isPending}>
                {t("feedback.thread.reply")}
              </Button>
            </form>
          )}
          <div>
            {q.data.status === "closed" || q.data.status === "resolved" ? (
              <Button
                variant="outline"
                size="sm"
                loading={setStatus.isPending}
                onClick={() => void change("open")}
              >
                <LockOpen aria-hidden /> {t("feedback.thread.reopen")}
              </Button>
            ) : null}
            {q.data.status !== "closed" ? (
              <Button
                variant="outline"
                size="sm"
                className={q.data.status === "resolved" ? "ml-2" : undefined}
                loading={setStatus.isPending}
                onClick={() => void change("closed")}
              >
                <Lock aria-hidden /> {t("feedback.thread.close")}
              </Button>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

function MessageBubble({ message }: { message: TicketMessagePayload }) {
  const { t } = useT();
  const mine = message.kind === "user";
  return (
    <li className={cn("flex flex-col gap-1", mine ? "items-end" : "items-start")}>
      <span className="text-xs text-muted-foreground">
        {mine ? t("feedback.thread.you") : t("feedback.thread.team")} ·{" "}
        {formatDateTime(message.created_at)}
      </span>
      <p
        className={cn(
          "max-w-full rounded-xl px-3 py-2 text-sm whitespace-pre-wrap break-words",
          mine ? "bg-accent text-foreground" : "border border-border bg-surface-1",
        )}
      >
        {message.body}
      </p>
    </li>
  );
}
