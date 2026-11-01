import type { ReactNode } from "react";
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
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="text-sm text-muted-foreground">{subtitle}</p>
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
      className="flex items-center gap-2 text-xs text-muted-foreground"
      aria-live="off"
      data-testid="live-status"
    >
      {live ? (
        <span
          role="img"
          aria-label={failed ? "Sem conexão com o servidor" : "Ao vivo"}
          className={cn(
            "size-2 rounded-full",
            failed ? "bg-destructive" : "bg-emerald-500",
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
      className={cn("rounded-xl border bg-card p-5 text-card-foreground shadow-sm", className)}
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
}: {
  label: string;
  value: string;
  detail?: ReactNode;
  tone?: "up" | "down";
}) {
  return (
    <div className="rounded-xl border bg-card p-4 text-card-foreground shadow-sm">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {detail ? (
        <p
          className={cn(
            "mt-1 text-xs text-muted-foreground",
            tone === "up" && "text-emerald-600 dark:text-emerald-400",
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
      className="rounded-md border border-destructive/40 p-3 text-sm text-destructive-text"
    >
      {children}
    </p>
  );
}

export function Unavailable({ title, reason }: { title: string; reason?: string }) {
  return (
    <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
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
                className={last ? "fill-primary/45" : "fill-primary"}
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
      <p
        className={cn(
          "text-xs",
          up && "text-emerald-600 dark:text-emerald-400",
          down && "text-destructive-text",
        )}
      >
        {up ? "Em alta" : down ? "Em queda" : "Estável ou sem base de comparação"} · hoje (barra
        clara) ainda não terminou
      </p>
      <details className="mt-2 text-sm">
        <summary className="cursor-pointer text-muted-foreground">Ver como tabela</summary>
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
