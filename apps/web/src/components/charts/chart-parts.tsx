import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** Tabela equivalente do gráfico, visualmente oculta (leitores de tela). */
export function ChartTable({
  caption,
  columns,
  rows,
}: {
  caption: string;
  columns: string[];
  rows: (string | number)[][];
}) {
  return (
    <table className="sr-only">
      <caption>{caption}</caption>
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c} scope="col">
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={String(row[0])}>
            {row.map((cell, i) =>
              i === 0 ? (
                <th key={`${row[0]}-${columns[i]}`} scope="row">
                  {cell}
                </th>
              ) : (
                <td key={`${row[0]}-${columns[i]}`}>{cell}</td>
              ),
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Esqueleto de carregamento do tamanho do gráfico. */
export function ChartSkeleton({ className }: { className?: string }) {
  return (
    <output className={cn("block", className)}>
      <Skeleton className="h-40 w-full" />
      <span className="sr-only">Carregando…</span>
    </output>
  );
}

/** Estado vazio: sem dados para desenhar. */
export function ChartEmpty({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}

/** Legenda: marcador (forma + cor) e rótulo em tinta de texto; nunca só cor. */
export function Legend({ items }: { items: { label: string; kind: "area" | "dashed" | "bar" }[] }) {
  return (
    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {items.map((it) => (
        <li key={it.label} className="flex items-center gap-1.5">
          {/* biome-ignore lint/a11y/noSvgWithoutTitle: marcador decorativo; o rótulo ao lado diz o mesmo */}
          <svg width="16" height="8" aria-hidden className="shrink-0">
            {it.kind === "dashed" ? (
              <line
                x1="0"
                x2="16"
                y1="4"
                y2="4"
                className="stroke-muted-foreground"
                strokeWidth="1.5"
                strokeDasharray="3 2"
              />
            ) : it.kind === "bar" ? (
              <rect x="0" y="0" width="16" height="8" rx="2" className="fill-brand-500" />
            ) : (
              <line x1="0" x2="16" y1="4" y2="4" className="stroke-brand-500" strokeWidth="2.5" />
            )}
          </svg>
          {it.label}
        </li>
      ))}
    </ul>
  );
}

/** Balão de detalhe (HTML, fora do SVG); aparece por hover ou foco. */
export function Tip({
  left,
  children,
}: {
  /** posição horizontal em % do gráfico */
  left: number;
  children: ReactNode;
}) {
  const edge = left > 70 ? "-translate-x-full" : left < 30 ? "" : "-translate-x-1/2";
  return (
    <output
      className={cn(
        "tabular pointer-events-none absolute top-0 z-10 rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md",
        edge,
      )}
      style={{ left: `${left}%` }}
    >
      {children}
    </output>
  );
}
