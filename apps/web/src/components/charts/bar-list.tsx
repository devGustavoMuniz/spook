import { memo, useState } from "react";
import { ChartEmpty, ChartSkeleton, ChartTable, Tip } from "./chart-parts";

export type BarItem = {
  key: string;
  label: string;
  value: number;
  /** Texto do valor à direita (padrão: o número). */
  display?: string;
  /** Detalhe extra no balão e na tabela (ex.: "5.000 linhas"). */
  detail?: string;
};

/**
 * Barras horizontais com rótulo à esquerda e valor à direita (HTML + CSS; a largura anima só por
 * `transform: scaleX`). Cada linha é focável: foco e hover mostram o balão com o detalhe.
 */
function BarListImpl({
  title,
  items,
  valueHeader = "Valor",
  loading = false,
  emptyText = "Sem dados.",
  max,
}: {
  title: string;
  items: BarItem[];
  valueHeader?: string;
  loading?: boolean;
  emptyText?: string;
  /** Teto da escala (padrão: o maior valor). */
  max?: number;
}) {
  const [active, setActive] = useState<string | null>(null);
  if (loading) return <ChartSkeleton />;
  if (items.length === 0) return <ChartEmpty>{emptyText}</ChartEmpty>;
  const top = Math.max(1, max ?? 0, ...items.map((i) => i.value));
  const cur = items.find((i) => i.key === active);
  return (
    <div className="relative">
      {cur ? (
        <Tip left={50}>
          <span className="font-medium">{cur.label}</span>: {cur.display ?? cur.value}
          {cur.detail ? <span className="text-muted-foreground"> · {cur.detail}</span> : null}
        </Tip>
      ) : null}
      <ul className="flex flex-col gap-1.5 pt-8" aria-label={title}>
        {items.map((it) => (
          <li
            key={it.key}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: foco por teclado para ver o detalhe da barra
            tabIndex={0}
            onPointerEnter={() => setActive(it.key)}
            onPointerLeave={() => setActive(null)}
            onFocus={() => setActive(it.key)}
            onBlur={() => setActive(null)}
            className="grid grid-cols-[minmax(0,7.5rem)_1fr_auto] items-center gap-2 rounded-md px-1 py-0.5 text-xs outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring sm:grid-cols-[minmax(0,10rem)_1fr_auto]"
          >
            <span className="truncate" title={it.label}>
              {it.label}
            </span>
            <span className="h-2.5 overflow-hidden rounded-full bg-muted" aria-hidden>
              <span
                className="block h-full origin-left rounded-full bg-brand-500 transition-transform duration-500 motion-reduce:transition-none"
                style={{
                  transform: `scaleX(${Math.max(it.value > 0 ? 0.015 : 0, it.value / top)})`,
                }}
              />
            </span>
            <span className="tabular min-w-12 text-right font-medium">
              {it.display ?? it.value}
            </span>
          </li>
        ))}
      </ul>
      <ChartTable
        caption={title}
        columns={["Item", valueHeader, "Detalhe"]}
        rows={items.map((i) => [i.label, i.display ?? i.value, i.detail ?? "—"])}
      />
    </div>
  );
}

export const BarList = memo(BarListImpl);
