import { useEffect, useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { readConnectionStats } from "./controller";
import type { ConnectionStats, LinkQuality } from "./engine";
import { useVoiceStore } from "./store";

export type NetworkRating = "good" | "medium" | "bad" | "unknown";

/** Limiares (bom até o primeiro valor, médio até o segundo, ruim acima). */
export const NETWORK_LIMITS = {
  rttMs: [100, 250],
  lossPct: [2, 5],
  jitterMs: [30, 60],
} as const;

const ORDER: NetworkRating[] = ["unknown", "good", "medium", "bad"];
const worst = (a: NetworkRating, b: NetworkRating) =>
  ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b;

function rateValue(v: number | null, [good, medium]: readonly [number, number]): NetworkRating {
  if (v === null) return "unknown";
  return v <= good ? "good" : v <= medium ? "medium" : "bad";
}

/** Nota geral: o pior entre RTT, perda e jitter; a qualidade do enlace da engine só piora a nota. */
export function rateNetwork(stats: ConnectionStats | null, quality: LinkQuality): NetworkRating {
  let r: NetworkRating = "unknown";
  if (stats) {
    r = worst(r, rateValue(stats.rttMs, NETWORK_LIMITS.rttMs));
    r = worst(r, rateValue(stats.lossPct, NETWORK_LIMITS.lossPct));
    r = worst(r, rateValue(stats.jitterMs, NETWORK_LIMITS.jitterMs));
  }
  if (quality === "lost") return "bad";
  if (quality === "poor") return worst(r, "medium");
  if (r === "unknown") return quality === "unknown" ? "unknown" : "good";
  return r;
}

const LABEL: Record<NetworkRating, string> = {
  good: "Conexão boa",
  medium: "Conexão instável",
  bad: "Conexão ruim",
  unknown: "Conexão sem medição",
};
const QUALITY_LABEL: Record<LinkQuality, string> = {
  excellent: "Conexão excelente",
  good: "Conexão boa",
  poor: "Conexão ruim",
  lost: "Conexão perdida",
  unknown: "Conexão sem medição",
};
const BARS: Record<NetworkRating, number> = { good: 3, medium: 2, bad: 1, unknown: 0 };

const fmt = (v: number | null, unit: string) =>
  v === null ? "sem medição" : `${String(v).replace(".", ",")} ${unit}`;

/** Texto com os números (tooltip e leitor de tela). */
export function statsText(stats: ConnectionStats | null): string {
  if (!stats) return "Sem números de rede neste app.";
  return `Latência ${fmt(stats.rttMs, "ms")} · Perda ${fmt(stats.lossPct, "%")} · Jitter ${fmt(stats.jitterMs, "ms")}`;
}

/** Mede a rede a cada `ms` enquanto conectado e com a aba visível. */
export function useConnectionStats(ms = 3000): ConnectionStats | null {
  const connected = useVoiceStore((s) => s.status === "connected");
  const [stats, setStats] = useState<ConnectionStats | null>(null);
  useEffect(() => {
    if (!connected) {
      setStats(null);
      return;
    }
    let alive = true;
    const tick = async () => {
      if (globalThis.document?.hidden) return;
      const next = await readConnectionStats();
      if (alive) setStats(next);
    };
    void tick();
    const t = setInterval(() => void tick(), ms);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [connected, ms]);
  return stats;
}

/**
 * Indicador de rede: três barras (verde, amarelo, vermelho) e, ao passar o mouse ou focar, os números de
 * latência, perda e jitter. Sem números (engine que não mede) cai na qualidade do enlace.
 */
export function NetworkIndicator({
  quality,
  className,
  showLabel = false,
}: {
  quality: LinkQuality;
  className?: string;
  showLabel?: boolean;
}) {
  const stats = useConnectionStats();
  const rating = rateNetwork(stats, quality);
  const bars = BARS[rating];
  // Sem números da engine, o nome é o da qualidade do enlace (como era antes do indicador completo).
  const text = stats ? `${LABEL[rating]}. ${statsText(stats)}` : QUALITY_LABEL[quality];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={text}
          data-rating={rating}
          data-quality={quality}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: precisa de foco para mostrar os números por teclado
          tabIndex={0}
          className={cn(
            "inline-flex cursor-default items-center gap-1.5 rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring",
            className,
          )}
        >
          <span className="flex h-4 items-end gap-0.5" aria-hidden>
            {[1, 2, 3].map((n) => (
              <span
                key={n}
                style={{ height: `${n * 33}%` }}
                className={cn(
                  "w-1 rounded-sm",
                  n <= bars
                    ? rating === "bad"
                      ? "bg-destructive"
                      : rating === "medium"
                        ? "bg-warning"
                        : "bg-success"
                    : "bg-muted-foreground/30",
                )}
              />
            ))}
          </span>
          {showLabel ? <span className="text-xs">{LABEL[rating]}</span> : null}
        </span>
      </TooltipTrigger>
      <TooltipContent className="flex flex-col gap-0.5">
        <span className="font-medium">{stats ? LABEL[rating] : QUALITY_LABEL[quality]}</span>
        {stats ? <span>{statsText(stats)}</span> : null}
      </TooltipContent>
    </Tooltip>
  );
}
