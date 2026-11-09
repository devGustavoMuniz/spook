import {
  type AdminListTicketsKind,
  type AdminListTicketsSort,
  type AdminListTicketsStatus,
  type AdminTicketPayload,
  adminListTickets,
  getAdminGetTicketQueryKey,
  isApiError,
  useAdminGetTicket,
  useAdminReplyTicket,
  useAdminSetTicketStatus,
} from "@spook/shared";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ArrowLeft, Lock, Search } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { ErrorNote, LiveStatus, PageHeader } from "@/features/admin/ui";
import { useDebounced } from "@/features/admin/use-debounced";
import { MessageAttachments } from "@/features/attachments/message-attachments";
import { AttachmentPicker, attachmentDropProps } from "@/features/feedback/attachment-picker";
import { pinAttachmentUrls } from "@/features/feedback/attachments";
import { useTicketAttachments } from "@/features/feedback/use-ticket-attachments";
import { messageFor } from "@/lib/errors";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

const STATUS_LABEL = {
  open: "Aberto",
  in_review: "Em análise",
  answered: "Respondido",
  resolved: "Resolvido",
  closed: "Fechado",
} as const;
const KIND_LABEL = { bug: "Bug", suggestion: "Sugestão", feedback: "Feedback" } as const;
const STATUS_VARIANT = {
  open: "info",
  in_review: "warning",
  answered: "brand",
  resolved: "success",
  closed: "secondary",
} as const;
const STATUSES = Object.keys(STATUS_LABEL) as (keyof typeof STATUS_LABEL)[];
const PAGE = 20;
const BODY_MAX = 4000;

const selectClass =
  "h-9 rounded-md border border-input bg-field px-2 text-sm text-foreground shadow-xs hover:border-brand-400";

/** A chave começa por `/api/admin/tickets`: a invalidação depois de responder alcança lista, resumo e detalhe. */
function invalidateTickets(qc: ReturnType<typeof useQueryClient>) {
  return qc.invalidateQueries({
    predicate: (q) =>
      typeof q.queryKey[0] === "string" && q.queryKey[0].startsWith("/api/admin/tickets"),
  });
}

/** Chamados de feedback: fila à esquerda (filtros, busca, ordenação, cursor) e a conversa à direita. */
export function AdminTicketsPage() {
  const { ticketId } = useParams({ strict: false }) as { ticketId?: string };
  const [status, setStatus] = useState<AdminListTicketsStatus | "">("");
  const [kind, setKind] = useState<AdminListTicketsKind | "">("");
  const [sort, setSort] = useState<AdminListTicketsSort>("activity");
  const [text, setText] = useState("");
  const q = useDebounced(text);
  const query = useInfiniteQuery({
    queryKey: ["/api/admin/tickets", "queue", { status, kind, sort, q }],
    queryFn: ({ pageParam, signal }) =>
      adminListTickets(
        {
          limit: PAGE,
          sort,
          ...(status ? { status } : {}),
          ...(kind ? { kind } : {}),
          ...(q ? { q } : {}),
          ...(pageParam ? { cursor: pageParam } : {}),
        },
        { signal },
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    refetchInterval: 30_000,
  });
  const items = query.data?.pages.flatMap((p) => p.items ?? []) ?? [];

  return (
    <>
      <PageHeader title="Chamados" subtitle="Feedback, sugestões e bugs enviados pelos usuários.">
        <LiveStatus
          updatedAt={query.dataUpdatedAt}
          fetching={query.isFetching}
          failed={query.isError}
        />
      </PageHeader>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <section
          aria-label="Fila de chamados"
          className={cn("flex min-w-0 flex-col gap-3", ticketId ? "max-lg:hidden" : "")}
        >
          <div className="relative">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              type="search"
              aria-label="Buscar por título ou usuário"
              placeholder="Buscar por título ou usuário"
              className="pl-8"
              value={text}
              maxLength={100}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <select
              aria-label="Filtrar por estado"
              className={selectClass}
              value={status}
              onChange={(e) => setStatus(e.target.value as AdminListTicketsStatus | "")}
            >
              <option value="">Todos os estados</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
            <select
              aria-label="Filtrar por tipo"
              className={selectClass}
              value={kind}
              onChange={(e) => setKind(e.target.value as AdminListTicketsKind | "")}
            >
              <option value="">Todos os tipos</option>
              {(Object.keys(KIND_LABEL) as (keyof typeof KIND_LABEL)[]).map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
            <select
              aria-label="Ordenar"
              className={selectClass}
              value={sort}
              onChange={(e) => setSort(e.target.value as AdminListTicketsSort)}
            >
              <option value="activity">Movimento mais recente</option>
              <option value="oldest">Mais antigos primeiro</option>
            </select>
          </div>
          {query.isPending ? (
            <Skeleton className="h-24 w-full" />
          ) : query.isError ? (
            <QueryError onRetry={() => void query.refetch()} />
          ) : items.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              Nenhum chamado encontrado.
            </p>
          ) : (
            <ul aria-label="Chamados" className="flex flex-col gap-1.5">
              {items.map((t) => (
                <li key={t.id}>
                  <QueueRow ticket={t} active={t.id === ticketId} />
                </li>
              ))}
            </ul>
          )}
          {query.hasNextPage ? (
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              loading={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              Carregar mais
            </Button>
          ) : null}
        </section>
        <section aria-label="Conversa" className={cn("min-w-0", ticketId ? "" : "max-lg:hidden")}>
          {ticketId ? (
            <TicketDetail key={ticketId} id={ticketId} />
          ) : (
            <p className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
              Escolha um chamado na fila para ver a conversa.
            </p>
          )}
        </section>
      </div>
    </>
  );
}

function QueryError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-col items-start gap-2">
      <ErrorNote>Não foi possível carregar os chamados.</ErrorNote>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Tentar de novo
      </Button>
    </div>
  );
}

function QueueRow({ ticket, active }: { ticket: AdminTicketPayload; active: boolean }) {
  return (
    <Link
      to="/admin/tickets/$ticketId"
      params={{ ticketId: ticket.id }}
      aria-current={active ? "true" : undefined}
      className={cn(
        "flex flex-col gap-1.5 rounded-lg border px-3 py-2.5 transition-colors hover:border-brand-400",
        active ? "border-primary bg-accent/50" : "border-border bg-surface-1",
      )}
    >
      <span className="truncate text-sm font-medium">{ticket.title}</span>
      <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant={STATUS_VARIANT[ticket.status]}>{STATUS_LABEL[ticket.status]}</Badge>
        <span>{KIND_LABEL[ticket.kind]}</span>
        <span aria-hidden>·</span>
        <span>@{ticket.author.username}</span>
        <span aria-hidden>·</span>
        <span>{formatDateTime(ticket.last_activity_at)}</span>
      </span>
    </Link>
  );
}

function TicketDetail({ id }: { id: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useAdminGetTicket(id, { query: { refetchInterval: 15_000 } });
  const reply = useAdminReplyTicket();
  const setStatus = useAdminSetTicketStatus();
  const att = useTicketAttachments(id);
  const [body, setBody] = useState("");
  const [internal, setInternal] = useState(false);

  async function send() {
    const text = body.trim();
    if (!text) return;
    const ids = att.readyIds();
    if (!ids) return;
    try {
      await reply.mutateAsync({
        id,
        data: { body: text, internal, ...(ids.length > 0 ? { attachment_ids: ids } : {}) },
      });
      setBody("");
      att.done();
      toast.success(internal ? "Nota interna registrada." : "Resposta enviada ao usuário.");
      await invalidateTickets(qc);
    } catch (e) {
      toast.error(messageFor(e));
      if (ids.length > 0 && isApiError(e) && e.status >= 400 && e.status < 500) {
        att.rejected("Os anexos foram recusados: envie as imagens de novo.");
      }
    }
  }

  async function change(next: keyof typeof STATUS_LABEL) {
    try {
      await setStatus.mutateAsync({ id, data: { status: next } });
      toast.success(`Estado alterado para "${STATUS_LABEL[next]}".`);
      await qc.invalidateQueries({ queryKey: getAdminGetTicketQueryKey(id) });
      await invalidateTickets(qc);
    } catch (e) {
      toast.error(messageFor(e));
    }
  }

  if (q.isPending) return <Skeleton className="h-64 w-full" />;
  if (q.isError) return <QueryError onRetry={() => void q.refetch()} />;
  const t = q.data;
  const closed = t.status === "closed";
  return (
    <article className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5 text-card-foreground shadow-sm">
      <Button
        variant="ghost"
        size="sm"
        className="self-start lg:hidden"
        onClick={() => void navigate({ to: "/admin/tickets" })}
      >
        <ArrowLeft aria-hidden /> Voltar à fila
      </Button>
      <header className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold text-balance">{t.title}</h2>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant={STATUS_VARIANT[t.status]}>{STATUS_LABEL[t.status]}</Badge>
          <span>{KIND_LABEL[t.kind]}</span>
          <span aria-hidden>·</span>
          <span>Aberto em {formatDateTime(t.created_at)}</span>
        </div>
        <p className="text-sm">
          <span className="font-medium">@{t.author.username}</span>
          {t.author.display_name ? ` (${t.author.display_name})` : ""}
          {" · "}
          <a className="underline underline-offset-2" href={`mailto:${t.author.email}`}>
            {t.author.email}
          </a>
        </p>
        <label className="flex items-center gap-2 text-sm">
          Estado
          <select
            aria-label="Alterar o estado"
            className={selectClass}
            value={t.status}
            disabled={setStatus.isPending}
            onChange={(e) => void change(e.target.value as keyof typeof STATUS_LABEL)}
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
      </header>
      {t.context ? (
        <details className="rounded-lg border border-border p-3 text-xs text-muted-foreground">
          <summary className="cursor-pointer font-medium">Contexto técnico</summary>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            {Object.entries(t.context)
              .filter(([, v]) => !!v)
              .map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="font-medium">{k}</dt>
                  <dd className="min-w-0 break-words">{String(v)}</dd>
                </div>
              ))}
          </dl>
        </details>
      ) : null}
      <ol aria-label="Mensagens" className="flex flex-col gap-3">
        {(t.messages ?? []).map((m) => (
          <li
            key={m.id}
            data-kind={m.kind}
            className={cn(
              "flex flex-col gap-1 rounded-lg border p-3",
              m.kind === "internal"
                ? "border-warning-text/40 bg-warning-soft"
                : m.kind === "admin"
                  ? "border-border bg-accent/40"
                  : "border-border bg-surface-1",
            )}
          >
            <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {m.kind === "internal" ? (
                <Badge variant="warning">
                  <Lock aria-hidden /> Nota interna
                </Badge>
              ) : m.kind === "admin" ? (
                <Badge variant="brand">Resposta da equipe</Badge>
              ) : (
                <Badge variant="secondary">Usuário</Badge>
              )}
              {m.username ? <span>@{m.username}</span> : null}
              <span>{formatDateTime(m.created_at)}</span>
            </span>
            <p className="text-sm whitespace-pre-wrap break-words">{m.body}</p>
            <MessageAttachments attachments={pinAttachmentUrls(m.attachments)} />
          </li>
        ))}
      </ol>
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
        {...attachmentDropProps(att)}
      >
        <label htmlFor="admin-ticket-reply" className="text-sm font-medium">
          {internal ? "Nota interna" : "Responder ao usuário"}
        </label>
        <Textarea
          id="admin-ticket-reply"
          rows={4}
          maxLength={BODY_MAX}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={internal ? "Só administradores veem esta nota." : "O usuário será avisado."}
        />
        <AttachmentPicker att={att} />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={internal}
              onChange={(e) => setInternal(e.target.checked)}
            />
            Nota interna (invisível para o usuário)
          </label>
          <Button
            type="submit"
            loading={reply.isPending}
            disabled={!body.trim() || (!internal && closed)}
          >
            {internal ? "Salvar nota" : "Enviar resposta"}
          </Button>
        </div>
        {closed && !internal ? (
          <p className="text-xs text-muted-foreground">
            Chamado fechado: reabra (altere o estado) para responder ao usuário.
          </p>
        ) : null}
      </form>
    </article>
  );
}
