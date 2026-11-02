// biome-ignore-all lint/a11y/useSemanticElements: grupo focável para navegar pelos pontos; fieldset não serve a um gráfico
// biome-ignore-all lint/a11y/useFocusableInteractive: foco por teclado dentro das células (roving tabindex)
import { memo, useEffect, useId, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { ChartEmpty, ChartSkeleton, ChartTable, Legend, Tip } from "./chart-parts";
import { areaPath, linear, linePath, nearestIndex, niceMax, type Pt, ticks } from "./scales";

export type SeriesPoint = {
  /** Chave estável do ponto (ex.: "2026-10-31"); aparece na tabela acessível. */
  key: string;
  /** Rótulo curto no eixo e no balão (ex.: "31/10"). */
  label: string;
  value: number;
};

const defaultFormat = (n: number) => String(n);
const DEFAULT_W = 560;
const H = 160;
const PAD_L = 34;
const PAD_R = 8;
const PAD_T = 8;
const PAD_B = 22;

/**
 * Série temporal em linha + área. `previous` (opcional) alinha por índice com `points` e desenha o período
 * anterior em traço fino e tracejado (null = sem base de comparação naquele ponto). O último ponto é
 * parcial (`lastPartial`) e sai tracejado/aberto. Hover, toque e teclado (setas, Home, End) mostram o
 * balão; Esc o fecha. A tabela equivalente fica oculta visualmente.
 */
function TimeSeriesChartImpl({
  title,
  points,
  previous,
  previousLabel = "Período anterior",
  seriesLabel = "Período atual",
  caption,
  lastPartial = false,
  loading = false,
  emptyText = "Sem dados no período.",
  formatValue = defaultFormat,
  className,
}: {
  title: string;
  points: SeriesPoint[];
  previous?: (number | null)[];
  previousLabel?: string;
  seriesLabel?: string;
  /** Legenda da tabela (padrão: "<título> por dia (UTC)"). */
  caption?: string;
  lastPartial?: boolean;
  loading?: boolean;
  emptyText?: string;
  formatValue?: (n: number) => string;
  className?: string;
}) {
  const gid = useId();
  const [active, setActive] = useState<number | null>(null);
  // Largura real do contêiner: o SVG desenha 1:1 (texto legível em 390 px, sem escalar o viewBox).
  const [W, setW] = useState(DEFAULT_W);
  const boxRef = useRef<HTMLDivElement>(null);
  const ready = !loading && points.length > 0;
  useEffect(() => {
    const el = ready ? boxRef.current : null;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.round(entry?.contentRect.width ?? 0);
      if (w >= 200) setW(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ready]);

  const geo = useMemo(() => {
    const vals = [...points.map((p) => p.value), ...(previous ?? []).map((v) => v ?? 0)];
    const max = niceMax(Math.max(0, ...vals));
    const n = points.length;
    // Margem esquerda proporcional ao maior rótulo do eixo ("100.000" não pode ser cortado).
    const padL = Math.max(
      PAD_L,
      12 + 6 * Math.max(...ticks(max, 2).map((t) => formatValue(t).length)),
    );
    const x = linear(0, Math.max(1, n - 1), padL, W - PAD_R);
    const y = linear(0, max, H - PAD_B, PAD_T);
    const pts: Pt[] = points.map((p, i) => ({ x: x(i), y: y(p.value) }));
    const prev: (Pt | null)[] = points.map((_, i) => {
      const v = previous?.[i];
      return v === null || v === undefined ? null : { x: x(i), y: y(v) };
    });
    return { max, pts, prev, y, x, padL };
  }, [points, previous, formatValue, W]);

  if (loading) return <ChartSkeleton className={className} />;
  if (points.length === 0) return <ChartEmpty>{emptyText}</ChartEmpty>;

  const n = points.length;
  const hasPrev = !!previous?.some((v) => v !== null && v !== undefined);
  const solid = lastPartial && n > 1 ? geo.pts.slice(0, -1) : geo.pts;
  const tail = lastPartial && n > 1 ? geo.pts.slice(-2) : [];
  const baseline = H - PAD_B;
  const cur = active === null ? null : points[active];
  const curPrev = active === null ? null : (previous?.[active] ?? null);
  const labelEvery = n > 8 ? 2 : 1;

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const px = ((e.clientX - rect.left) / rect.width) * W;
    setActive(nearestIndex(px - geo.padL, W - geo.padL - PAD_R, n));
  };
  const onKey = (e: React.KeyboardEvent) => {
    const step = (d: number) => setActive((a) => Math.min(n - 1, Math.max(0, (a ?? n - 1) + d)));
    if (e.key === "ArrowRight") step(1);
    else if (e.key === "ArrowLeft") step(-1);
    else if (e.key === "Home") setActive(0);
    else if (e.key === "End") setActive(n - 1);
    else if (e.key === "Escape") setActive(null);
    else return;
    e.preventDefault();
  };

  const tipLeft = active === null ? 0 : ((geo.pts[active] as Pt).x / W) * 100;

  return (
    <div className={className}>
      <div
        role="group"
        aria-label={`Explorar valores de ${title} (setas esquerda e direita)`}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: foco no gráfico para navegar os pontos por teclado
        tabIndex={0}
        onPointerMove={onMove}
        onPointerDown={onMove}
        onPointerLeave={() => setActive(null)}
        onBlur={() => setActive(null)}
        onFocus={() => setActive((a) => a ?? n - 1)}
        onKeyDown={onKey}
        className="relative rounded-md pt-8 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-testid="time-series"
        ref={boxRef}
      >
        {cur ? (
          <Tip left={tipLeft}>
            <span className="font-medium">{cur.label}</span>: {formatValue(cur.value)}
            {hasPrev ? (
              <span className="text-muted-foreground">
                {" "}
                · {previousLabel.toLowerCase()}: {curPrev === null ? "—" : formatValue(curPrev)}
              </span>
            ) : null}
          </Tip>
        ) : null}
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="block w-full"
          height={H}
          role="img"
          aria-label={`${title}: ${n} pontos, de ${points[0]?.label} a ${points[n - 1]?.label}, máximo ${formatValue(Math.max(...points.map((p) => p.value)))}. Detalhes na tabela.`}
        >
          <defs>
            <linearGradient id={`${gid}-fill`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" className="[stop-color:var(--brand-500)]" stopOpacity="0.32" />
              <stop offset="100%" className="[stop-color:var(--brand-500)]" stopOpacity="0.02" />
            </linearGradient>
          </defs>
          {ticks(geo.max, 2).map((t, i) => (
            <g key={t}>
              <line
                x1={geo.padL}
                x2={W - PAD_R}
                y1={geo.y(t)}
                y2={geo.y(t)}
                className="stroke-border"
                strokeWidth={1}
                strokeDasharray={i === 0 ? undefined : "3 5"}
              />
              <text
                x={geo.padL - 6}
                y={geo.y(t) + 3}
                textAnchor="end"
                className="tabular fill-muted-foreground text-[10px]"
              >
                {formatValue(t)}
              </text>
            </g>
          ))}
          {points.map((p, i) =>
            i % labelEvery === (n - 1) % labelEvery ? (
              <text
                key={p.key}
                x={(geo.pts[i] as Pt).x}
                y={H - 6}
                textAnchor="middle"
                className="fill-muted-foreground text-[10px]"
              >
                {p.label}
              </text>
            ) : null,
          )}
          {solid.length > 1 ? (
            <path d={areaPath(solid, baseline)} fill={`url(#${gid}-fill)`} stroke="none" />
          ) : null}
          {hasPrev ? (
            <path
              d={linePath(geo.prev)}
              className="stroke-muted-foreground"
              fill="none"
              strokeWidth={1.25}
              strokeDasharray="4 3"
              strokeLinecap="round"
              data-testid="previous-line"
            />
          ) : null}
          <path
            d={linePath(solid)}
            className="stroke-brand-500"
            fill="none"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            data-testid="current-line"
          />
          {tail.length === 2 ? (
            <path
              d={linePath(tail)}
              className="stroke-brand-500"
              fill="none"
              strokeWidth={2}
              strokeDasharray="2 4"
              strokeLinecap="round"
            />
          ) : null}
          {active !== null ? (
            <g>
              <line
                x1={(geo.pts[active] as Pt).x}
                x2={(geo.pts[active] as Pt).x}
                y1={PAD_T}
                y2={baseline}
                className="stroke-muted-foreground"
                strokeWidth={1}
                opacity={0.5}
              />
              <circle
                cx={(geo.pts[active] as Pt).x}
                cy={(geo.pts[active] as Pt).y}
                r={4.5}
                className="fill-brand-500 stroke-card"
                strokeWidth={2}
              />
            </g>
          ) : (
            <circle
              cx={(geo.pts[n - 1] as Pt).x}
              cy={(geo.pts[n - 1] as Pt).y}
              r={3.5}
              className={cn(
                "stroke-card",
                lastPartial ? "fill-card stroke-brand-500" : "fill-brand-500",
              )}
              strokeWidth={lastPartial ? 1.5 : 2}
            />
          )}
        </svg>
      </div>
      <Legend
        items={[
          { label: seriesLabel, kind: "area" },
          ...(hasPrev ? [{ label: previousLabel, kind: "dashed" as const }] : []),
        ]}
      />
      <ChartTable
        caption={caption ?? `${title} por dia (UTC)`}
        columns={["Dia", seriesLabel, ...(hasPrev ? [previousLabel] : [])]}
        rows={points.map((p, i) => [p.key, p.value, ...(hasPrev ? [previous?.[i] ?? "—"] : [])])}
      />
    </div>
  );
}

export const TimeSeriesChart = memo(TimeSeriesChartImpl);
