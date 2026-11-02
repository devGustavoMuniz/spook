import { ArrowDownRight, ArrowUpRight, CircleAlert, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatClockTime } from "./format";

/** Cabeçalho de página: título, subtítulo e o indicador de atualização à direita. */
export function PageHeader({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-balance">{title}</h1>
        <p className="text-sm text-muted-foreground text-pretty">{subtitle}</p>
      </div>
      {children}
    </div>
  );
}

/** "Atualizado em hh:mm:ss" + ponto de "ao vivo" (pulsa quando a última leitura deu certo). */
export function LiveStatus({
  updatedAt,
  fetching,
  failed,
  live = true,
}: {
  updatedAt: number;
  fetching?: boolean;
  failed?: boolean;
  live?: boolean;
}) {
  return (
    <p
      className="tabular flex items-center gap-2 rounded-full border border-border bg-surface-1 px-3 py-1 text-xs text-muted-foreground"
      aria-live="off"
      data-testid="live-status"
    >
      {live ? (
        <span
          role="img"
          aria-label={failed ? "Sem conexão com o servidor" : "Ao vivo"}
          className={cn(
            "size-2 rounded-full",
            failed ? "bg-destructive" : "bg-online",
            !failed && fetching ? "animate-pulse" : "",
          )}
        />
      ) : null}
      {updatedAt > 0 ? `Atualizado em ${formatClockTime(updatedAt)}` : "Carregando…"}
      {failed ? " (falha na última leitura)" : ""}
    </p>
  );
}

export function Section({
  title,
  hint,
  children,
  className,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "rounded-xl border border-border bg-card p-5 text-card-foreground shadow-sm",
        className,
      )}
    >
      <header className="mb-4">
        <h2 className="text-base font-semibold">{title}</h2>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </header>
      {children}
    </section>
  );
}

export function StatCard({
  label,
  value,
  detail,
  tone,
  icon: Icon,
  loading,
  spark,
}: {
  label: string;
  value: string;
  detail?: ReactNode;
  tone?: "up" | "down";
  icon?: LucideIcon;
  /** Primeira leitura ainda não chegou: mostra um esqueleto no lugar do número. */
  loading?: boolean;
  /** Miniatura de tendência (sparkline) no canto inferior direito. */
  spark?: ReactNode;
}) {
  return (
    <div className="relative rounded-xl border border-border bg-card p-4 text-card-foreground shadow-sm">
      {Icon ? (
        <span
          aria-hidden
          className="absolute top-3.5 right-3.5 flex size-8 items-center justify-center rounded-lg bg-accent text-brand-text"
        >
          <Icon className="size-4" />
        </span>
      ) : null}
      <p className="min-h-8 pr-10 text-xs leading-4 font-medium text-muted-foreground">{label}</p>
      {loading ? (
        <Skeleton className="h-8 w-20" />
      ) : (
        <p className="tabular text-2xl font-semibold">{value}</p>
      )}
      <div className="mt-1 flex items-end justify-between gap-2">
        {detail ? (
          <p
            className={cn(
              "tabular flex min-w-0 items-center gap-1 text-xs text-muted-foreground",
              tone === "up" && "text-success-text",
              tone === "down" && "text-destructive-text",
            )}
          >
            {tone === "up" ? <ArrowUpRight className="size-3.5 shrink-0" aria-hidden /> : null}
            {tone === "down" ? <ArrowDownRight className="size-3.5 shrink-0" aria-hidden /> : null}
            <span className="min-w-0">{detail}</span>
          </p>
        ) : (
          <span />
        )}
        {spark ? <div className="shrink-0">{spark}</div> : null}
      </div>
    </div>
  );
}

/** Pares rótulo/valor (lista de definição). */
export function Facts({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
      {items.map(([k, v]) => (
        <div
          key={k}
          className="flex items-baseline justify-between gap-3 border-b border-border/60 py-1"
        >
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="text-right font-medium tabular-nums">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-danger-soft p-3 text-sm text-destructive-text"
    >
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      {children}
    </p>
  );
}

export function Unavailable({ title, reason }: { title: string; reason?: string }) {
  return (
    <p className="rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground">
      <strong className="font-medium text-foreground">{title}: indisponível.</strong>{" "}
      {reason ?? "Sem dados no momento."}
    </p>
  );
}

/** Carregando um bloco: linhas de esqueleto; o texto fica só para leitores de tela. */
export function Loading({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <output className={cn("flex flex-col gap-2", className)}>
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: esqueleto estático
        <Skeleton key={i} className="h-5 w-full" />
      ))}
      <span className="sr-only">Carregando…</span>
    </output>
  );
}
