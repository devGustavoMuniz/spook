// Painel "Estatísticas da transmissão" do tile: o que CHEGA (quem assiste) ou o que SAI (quem transmite), lido da
// engine a cada segundo. É a ferramenta de diagnóstico de "não parece 1080p" (resolução/fps/bitrate reais, camada
// simulcast, motivo de limitação do codificador, tempo até o primeiro quadro). Os valores também ficam em
// atributos `data-*` (os testes E2E de medição leem daí).
import { useEffect, useState } from "react";
import { useT } from "@/i18n";
import type { StreamStats, VideoTrackInfo } from "../engine";

const STATS_KEY = "spook:voice-stream-stats";
export const STATS_POLL_MS = 1_000;

/** O painel fica aberto entre sessões (conveniência por navegador; indisponível = fechado). */
export function loadStatsOpen(): boolean {
  try {
    return localStorage.getItem(STATS_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveStatsOpen(open: boolean) {
  try {
    localStorage.setItem(STATS_KEY, open ? "1" : "0");
  } catch {
    // vale só nesta sessão
  }
}

/** Lê as estatísticas da faixa a cada `intervalMs` enquanto `enabled`. */
export function useStreamStats(
  track: VideoTrackInfo | undefined,
  enabled: boolean,
  intervalMs = STATS_POLL_MS,
): StreamStats | null {
  const [stats, setStats] = useState<StreamStats | null>(null);
  useEffect(() => {
    setStats(null);
    const read = track?.source.stats;
    if (!enabled || !read) return;
    let alive = true;
    const poll = async () => {
      try {
        const next = await read();
        if (alive) setStats(next);
      } catch {
        // a faixa pode ter acabado entre duas leituras
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), intervalMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [track, enabled, intervalMs]);
  return stats;
}

const attr = (v: number | string | null | undefined) => (v === null || v === undefined ? "" : v);

export function StreamStatsPanel({
  stats,
  firstFrameMs,
  className,
}: {
  stats: StreamStats | null;
  firstFrameMs: number | null;
  className?: string;
}) {
  const { t } = useT();
  const none = t("voice.stats.unknown");
  const rows: [string, string][] = [
    [
      t("voice.stats.resolution"),
      stats?.width && stats.height ? `${stats.width}×${stats.height}` : none,
    ],
    [t("voice.stats.fps"), stats?.fps != null ? String(stats.fps) : none],
    [
      t("voice.stats.bitrate"),
      stats?.bitrateKbps != null
        ? stats.bitrateKbps >= 1000
          ? `${(stats.bitrateKbps / 1000).toFixed(1)} Mbps`
          : `${stats.bitrateKbps} kbps`
        : none,
    ],
    [t("voice.stats.codec"), stats?.codec ?? none],
    [t("voice.stats.layer"), stats?.layer ?? none],
  ];
  if (stats?.limitation)
    rows.push([t("voice.stats.limitation"), t(`voice.stats.limitation.${stats.limitation}`)]);
  if (stats?.subscription)
    rows.push([t("voice.stats.subscription"), t(`voice.stats.subscription.${stats.subscription}`)]);
  if (firstFrameMs !== null) rows.push([t("voice.stats.firstFrame"), `${firstFrameMs} ms`]);
  return (
    <dl
      data-testid="stream-stats"
      data-role={attr(stats?.role)}
      data-width={attr(stats?.width)}
      data-height={attr(stats?.height)}
      data-fps={attr(stats?.fps)}
      data-kbps={attr(stats?.bitrateKbps)}
      data-codec={attr(stats?.codec)}
      data-layer={attr(stats?.layer)}
      data-limitation={attr(stats?.limitation)}
      data-first-frame-ms={attr(firstFrameMs)}
      aria-label={t("voice.stats.title")}
      className={
        className ??
        "pointer-events-none absolute top-2 left-2 z-[4] grid max-w-[min(18rem,calc(100%-1rem))] grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-lg bg-black/70 px-2.5 py-2 text-[11px] leading-tight text-white backdrop-blur-sm"
      }
    >
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-white/60">{k}</dt>
          <dd className="text-right font-medium tabular-nums">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
