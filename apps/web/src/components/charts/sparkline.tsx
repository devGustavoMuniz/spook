import { memo } from "react";
import { areaPath, linear, linePath, type Pt } from "./scales";

const W = 96;
const H = 28;

/**
 * Miniatura de tendência (sem eixos). Decorativa para a interface visual, mas com `role="img"` e um
 * resumo falado (mínimo, máximo e atual); o número grande do cartão já é a leitura principal.
 */
function SparklineImpl({
  values,
  label,
  format = (n: number) => String(n),
}: {
  values: number[];
  label: string;
  format?: (n: number) => string;
}) {
  if (values.length < 2) {
    return <div aria-hidden className="h-7 w-24 border-b border-dashed border-border" />;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const x = linear(0, values.length - 1, 2, W - 2);
  // Intervalo plano: linha no meio, sem exagerar ruído.
  const y = linear(min, max === min ? min + 1 : max, H - 3, 3);
  const pts: Pt[] = values.map((v, i) => ({ x: x(i), y: max === min ? H / 2 : y(v) }));
  const last = pts[pts.length - 1] as Pt;
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-7 w-24 overflow-visible"
      role="img"
      aria-label={`${label}, últimos minutos: mínimo ${format(min)}, máximo ${format(max)}, atual ${format(values[values.length - 1] as number)}`}
    >
      <path d={areaPath(pts, H)} className="fill-brand-500/15" stroke="none" />
      <path
        d={linePath(pts)}
        className="stroke-brand-500"
        fill="none"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle
        cx={last.x}
        cy={last.y}
        r={2.5}
        className="fill-brand-500 stroke-card"
        strokeWidth={1.5}
      />
    </svg>
  );
}

export const Sparkline = memo(SparklineImpl);
