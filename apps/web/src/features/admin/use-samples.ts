import { useEffect, useMemo, useRef, useState } from "react";

export type Sample = { t: number; v: number };

export const SAMPLE_WINDOW_MS = 5 * 60_000;

/** Acrescenta uma amostra e descarta as mais velhas que a janela (puro, para testar). */
export function pushSample(
  samples: Sample[],
  t: number,
  v: number,
  windowMs = SAMPLE_WINDOW_MS,
): Sample[] {
  const last = samples[samples.length - 1];
  if (last && last.t === t) return samples;
  return [...samples, { t, v }].filter((s) => t - s.t <= windowMs);
}

/**
 * Amostras acumuladas no cliente (em memória) a cada leitura nova: `stamp` é o `dataUpdatedAt` da
 * consulta, então só amostra quando o polling trouxe dado de fato. Janela de ~5 min; some ao sair da página.
 */
export function useRollingSamples(
  value: number | null | undefined,
  stamp: number,
  windowMs = SAMPLE_WINDOW_MS,
): number[] {
  const [samples, setSamples] = useState<Sample[]>([]);
  const latest = useRef(value);
  latest.current = value;
  useEffect(() => {
    const v = latest.current;
    if (stamp > 0 && v !== null && v !== undefined) {
      setSamples((s) => pushSample(s, stamp, v, windowMs));
    }
  }, [stamp, windowMs]);
  return useMemo(() => samples.map((s) => s.v), [samples]);
}
