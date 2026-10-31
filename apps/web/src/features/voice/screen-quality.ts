// Qualidade do compartilhamento de tela: presets, estimativa de banda e persistência. Sem dependência de
// livekit-client (o mapeamento para as opções da lib mora em `web-engine.ts`); o desktop pode reutilizar a tabela.
import type { ScreenShareQuality } from "./engine";

export type QualityPresetId = "sharp" | "balanced" | "smooth" | "high";

export type QualityPreset = {
  id: QualityPresetId;
  label: string;
  hint: string;
  quality: ScreenShareQuality;
};

/**
 * O PADRÃO é "Nitidez" (1080p, 15 fps): é exatamente o que o livekit-client já publicava (`h1080fps15`, 2,5 Mbps),
 * então quem não mexe em nada não muda de comportamento. As demais são escolha explícita.
 */
export const QUALITY_PRESETS: readonly QualityPreset[] = [
  {
    id: "sharp",
    label: "Nitidez — 1080p 15 fps",
    hint: "Texto, código e apresentações. O mais leve dos Full HD.",
    quality: { height: 1080, fps: 15, priority: "detail" },
  },
  {
    id: "balanced",
    label: "Equilibrado — 1080p 30 fps",
    hint: "Uso geral, com movimento razoável. Usa o dobro da banda do padrão.",
    quality: { height: 1080, fps: 30, priority: "motion" },
  },
  {
    id: "smooth",
    label: "Fluidez — 720p 60 fps",
    hint: "Jogos e vídeos. Imagem menor, movimento suave. Pesa no processador.",
    quality: { height: 720, fps: 60, priority: "motion" },
  },
  {
    id: "high",
    label: "Alta — 1440p 30 fps",
    hint: "Tela grande e detalhada. Pesada para quem transmite e para o servidor.",
    quality: { height: 1440, fps: 30, priority: "detail" },
  },
];

export const DEFAULT_SCREEN_QUALITY: ScreenShareQuality = {
  height: 1080,
  fps: 15,
  priority: "detail",
};

export const SCREEN_HEIGHTS = [720, 1080, 1440] as const;
export const SCREEN_FPS = [15, 30, 60] as const;

/** Teto de subida padrão (kbps) por altura e fps. Os valores de 720p/1080p até 30 fps são os do livekit-client. */
const BASE_KBPS: Record<ScreenShareQuality["height"], Record<ScreenShareQuality["fps"], number>> = {
  720: { 15: 1500, 30: 2000, 60: 3500 },
  1080: { 15: 2500, 30: 5000, 60: 8000 },
  1440: { 15: 4000, 30: 7000, 60: 12000 },
};

/** Banda de subida estimada (kbps) POR espectador que recebe a camada principal; é o teto, o uso real é menor. */
export function estimateUplinkKbps(q: ScreenShareQuality): number {
  return q.maxBitrateKbps ?? BASE_KBPS[q.height][q.fps];
}

/** "2,5 Mbps" / "800 kbps". */
export function formatKbps(kbps: number): string {
  if (kbps < 1000) return `${Math.round(kbps)} kbps`;
  return `${(kbps / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} Mbps`;
}

/** Acima do padrão em custo? (mais banda, mais fps ou mais pixels que o 1080p 15 fps). */
export function isHeavy(q: ScreenShareQuality): boolean {
  return (
    estimateUplinkKbps(q) > estimateUplinkKbps(DEFAULT_SCREEN_QUALITY) ||
    q.fps > DEFAULT_SCREEN_QUALITY.fps ||
    q.height > DEFAULT_SCREEN_QUALITY.height
  );
}

export function presetIdOf(q: ScreenShareQuality): QualityPresetId | null {
  return (
    QUALITY_PRESETS.find(
      (p) =>
        p.quality.height === q.height &&
        p.quality.fps === q.fps &&
        p.quality.priority === q.priority &&
        q.maxBitrateKbps === undefined,
    )?.id ?? null
  );
}

// ---- Persistência (localStorage; try/catch: indisponível = vale só nesta sessão) ----

const KEY = "spook:voice-screen-quality";

const isOf = <T extends number>(list: readonly T[], v: unknown): v is T =>
  list.some((x) => x === v);

export function loadScreenQuality(): ScreenShareQuality {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, unknown>;
    const q: ScreenShareQuality = {
      height: isOf(SCREEN_HEIGHTS, raw.height) ? raw.height : DEFAULT_SCREEN_QUALITY.height,
      fps: isOf(SCREEN_FPS, raw.fps) ? raw.fps : DEFAULT_SCREEN_QUALITY.fps,
      priority:
        raw.priority === "motion" || raw.priority === "detail"
          ? raw.priority
          : DEFAULT_SCREEN_QUALITY.priority,
    };
    if (
      typeof raw.maxBitrateKbps === "number" &&
      raw.maxBitrateKbps >= 300 &&
      raw.maxBitrateKbps <= 20000
    )
      q.maxBitrateKbps = Math.round(raw.maxBitrateKbps);
    return q;
  } catch {
    return { ...DEFAULT_SCREEN_QUALITY };
  }
}

export function saveScreenQuality(q: ScreenShareQuality) {
  try {
    localStorage.setItem(KEY, JSON.stringify(q));
  } catch {
    // armazenamento indisponível: vale só nesta sessão
  }
}
