import { CircleAlert, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatChange, formatClockTime, shortDay } from "./format";

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
}: {
  label: string;
  value: string;
  detail?: ReactNode;
  tone?: "up" | "down";
  icon?: LucideIcon;
  /** Primeira leitura ainda não chegou: mostra um esqueleto no lugar do número. */
  loading?: boolean;
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
      {detail ? (
        <p
          className={cn(
            "tabular mt-1 text-xs text-muted-foreground",
            tone === "up" && "text-success-text",
            tone === "down" && "text-destructive-text",
          )}
        >
          {detail}
        </p>
      ) : null}
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

type Day = { date: string; count: number };

/**
 * Gráfico de barras em SVG. A tabela por trás (em "Ver como tabela") traz os mesmos números para quem
 * não enxerga o gráfico. O último dia (hoje, em UTC) é parcial e sai mais claro.
 */
export function BarChart({
  title,
  days,
  trend,
}: {
  title: string;
  days: Day[];
  trend: { recent: number; previous: number; change_pct: number | null };
}) {
  const max = Math.max(1, ...days.map((d) => d.count));
  const W = 560;
  const H = 150;
  const slot = W / Math.max(1, days.length);
  const up = trend.change_pct !== null && trend.change_pct > 0;
  const down = trend.change_pct !== null && trend.change_pct < 0;
  return (
    <Section
      title={title}
      hint={`Últimos 6 dias completos: ${trend.recent} · 6 anteriores: ${trend.previous} · variação ${formatChange(trend.change_pct)}`}
    >
      <svg
        viewBox={`0 0 ${W} ${H + 22}`}
        className="h-44 w-full"
        role="img"
        aria-label={`${title}, últimos ${days.length} dias (UTC). Detalhes na tabela abaixo.`}
      >
        <line x1={0} x2={W} y1={H} y2={H} className="stroke-border" strokeWidth={1} />
        <line
          x1={0}
          x2={W}
          y1={H / 2}
          y2={H / 2}
          className="stroke-border"
          strokeWidth={1}
          strokeDasharray="3 5"
          opacity={0.7}
        />
        <text x={0} y={10} className="tabular fill-muted-foreground text-[10px]">
          {max}
        </text>
        {days.map((d, i) => {
          const h = Math.round((d.count / max) * H);
          const x = i * slot + slot * 0.15;
          const last = i === days.length - 1;
          return (
            <g key={d.date}>
              <rect
                x={x}
                y={H - h}
                width={slot * 0.7}
                height={Math.max(h, d.count > 0 ? 2 : 1)}
                rx={2}
                className={cn(
                  "transition-colors",
                  last
                    ? "fill-brand-500/45 hover:fill-brand-500/70"
                    : "fill-brand-500 hover:fill-brand-400",
                )}
              >
                <title>{`${shortDay(d.date)}: ${d.count}`}</title>
              </rect>
              {i % 2 === (days.length - 1) % 2 ? (
                <text
                  x={x + (slot * 0.7) / 2}
                  y={H + 15}
                  textAnchor="middle"
                  className="fill-muted-foreground text-[10px]"
                >
                  {shortDay(d.date)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <p className={cn("text-xs", up && "text-success-text", down && "text-destructive-text")}>
        {up ? "Em alta" : down ? "Em queda" : "Estável ou sem base de comparação"} · hoje (barra
        clara) ainda não terminou
      </p>
      <details className="mt-2 text-sm">
        <summary className="cursor-pointer rounded-sm text-muted-foreground hover:text-foreground">
          Ver como tabela
        </summary>
        <table className="mt-2 w-full text-left text-xs">
          <caption className="sr-only">{`${title} por dia (UTC)`}</caption>
          <thead>
            <tr>
              <th scope="col" className="py-1 font-medium">
                Dia
              </th>
              <th scope="col" className="py-1 text-right font-medium">
                Quantidade
              </th>
            </tr>
          </thead>
          <tbody>
            {days.map((d) => (
              <tr key={d.date} className="border-t">
                <th scope="row" className="py-1 font-normal">
                  {d.date}
                </th>
                <td className="py-1 text-right tabular-nums">{d.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </Section>
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
