// biome-ignore-all lint/a11y/useSemanticElements: role meter em div: <meter> nativo não aceita o desenho em SVG nem valuetext com o nível
// biome-ignore-all lint/a11y/useFocusableInteractive: foco por teclado dentro das células (roving tabindex)
import { CircleAlert, CircleCheck, TriangleAlert } from "lucide-react";
import { memo } from "react";
import { cn } from "@/lib/utils";
import { arcPath, clamp01, type GaugeLevel, gaugeLevel, polar } from "./scales";

const W = 140;
const H = 84;
const CX = 70;
const CY = 74;
const R = 58;

const LEVEL = {
  good: { text: "Bom", cls: "stroke-online", tone: "text-success-text", Icon: CircleCheck },
  warn: { text: "Atenção", cls: "stroke-idle", tone: "text-warning-text", Icon: TriangleAlert },
  bad: {
    text: "Ruim",
    cls: "stroke-destructive-text",
    tone: "text-destructive-text",
    Icon: CircleAlert,
  },
} as const;

/**
 * Medidor semicircular com três faixas (bom/atenção/ruim). `value === null` = sem leitura. O nível
 * sempre aparece também em texto e ícone (nunca só cor). Acessível como `role="meter"`.
 */
function GaugeImpl({
  label,
  value,
  max,
  warnAt,
  badAt,
  higherIsWorse = true,
  format,
  hint,
}: {
  label: string;
  value: number | null;
  /** Fim da escala. */
  max: number;
  warnAt: number;
  badAt: number;
  higherIsWorse?: boolean;
  format: (n: number) => string;
  hint?: string;
}) {
  const has = value !== null && Number.isFinite(value);
  const frac = has ? clamp01((value as number) / max) : 0;
  const level: GaugeLevel | null = has
    ? gaugeLevel(value as number, warnAt, badAt, higherIsWorse)
    : null;
  const lv = level ? LEVEL[level] : null;
  const angle = frac * 180;
  const tip = polar(CX, CY, R, angle);
  const bandAt = (v: number) => clamp01(v / max) * 180;
  const bands: [number, number, GaugeLevel][] = higherIsWorse
    ? [
        [0, bandAt(warnAt), "good"],
        [bandAt(warnAt), bandAt(badAt), "warn"],
        [bandAt(badAt), 180, "bad"],
      ]
    : [
        [0, bandAt(badAt), "bad"],
        [bandAt(badAt), bandAt(warnAt), "warn"],
        [bandAt(warnAt), 180, "good"],
      ];
  const valueText = has ? `${format(value as number)}, ${lv?.text}` : "sem leitura";
  return (
    <div className="flex flex-col items-center text-center" data-testid="gauge">
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={has ? (value as number) : undefined}
        aria-valuetext={valueText}
        className="relative w-full max-w-40"
      >
        {/* biome-ignore lint/a11y/noSvgWithoutTitle: decorativo; o medidor é o role="meter" acima */}
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" aria-hidden>
          <path
            d={arcPath(CX, CY, R, 0, 180)}
            className="stroke-muted"
            fill="none"
            strokeWidth={10}
            strokeLinecap="round"
          />
          {bands.map(([a, b, l]) =>
            b - a > 0.5 ? (
              <path
                key={l}
                d={arcPath(CX, CY, R, a, b)}
                className={cn(LEVEL[l].cls, has && l !== level ? "opacity-30" : "opacity-100")}
                fill="none"
                strokeWidth={10}
                strokeLinecap="butt"
              />
            ) : null,
          )}
          {has ? (
            <circle
              cx={tip.x}
              cy={tip.y}
              r={6}
              className="fill-foreground stroke-card"
              strokeWidth={2.5}
              data-testid="gauge-needle"
            />
          ) : null}
        </svg>
        <p className="tabular absolute inset-x-0 bottom-0 text-xl font-semibold leading-none">
          {has ? format(value as number) : "—"}
        </p>
      </div>
      <p className="mt-1 text-xs font-medium">{label}</p>
      <p className={cn("flex items-center gap-1 text-xs", lv ? lv.tone : "text-muted-foreground")}>
        {lv ? <lv.Icon className="size-3.5" aria-hidden /> : null}
        {lv ? lv.text : "Sem leitura"}
      </p>
      {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export const Gauge = memo(GaugeImpl);
