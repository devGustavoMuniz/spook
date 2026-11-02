// Qualidade do compartilhamento de tela: resolução + taxa de quadros (como no Discord), estimativa de banda e
// persistência. Sem dependência de livekit-client (o mapeamento para as opções da lib mora em `web-engine.ts`);
// o desktop reutiliza a tabela.
import type { ScreenShareQuality } from "./engine";

export const SCREEN_HEIGHTS = [720, 1080, 1440] as const;
export const SCREEN_FPS = [15, 30, 60] as const;

/** O que o usuário escolhe no diálogo: só resolução e quadros por segundo. */
export type ScreenChoice = Pick<ScreenShareQuality, "height" | "fps">;

/**
 * Padrão 1080p/30 fps (5 Mbps na tabela, o mesmo preset `h1080fps30` do livekit-client). O do Discord é 720p/30;
 * 1080p/30 custa mais banda (2x o antigo 1080p/15) mas texto e código ficam legíveis, e a tabela já o suporta.
 */
export const DEFAULT_SCREEN_CHOICE: ScreenChoice = { height: 1080, fps: 30 };

/** A prioridade não é escolha do usuário: até 15 fps é conteúdo estático (detalhe); acima disso, movimento. */
export function priorityFor(fps: ScreenChoice["fps"]): ScreenShareQuality["priority"] {
  return fps <= 15 ? "detail" : "motion";
}

/** Escolha do usuário -> contrato da engine (a prioridade é derivada; o teto de banda vem da tabela). */
export function qualityOf(c: ScreenChoice): ScreenShareQuality {
  return { height: c.height, fps: c.fps, priority: priorityFor(c.fps) };
}

export const DEFAULT_SCREEN_QUALITY: ScreenShareQuality = qualityOf(DEFAULT_SCREEN_CHOICE);

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

/** Escolhas que pesam em processador e banda (1440p ou 60 fps): o diálogo avisa. */
export function isHeavy(q: ScreenChoice): boolean {
  return q.height >= 1440 || q.fps >= 60;
}

// ---- Persistência (localStorage; try/catch: indisponível = vale só nesta sessão) ----

/**
 * Chave antiga: guardava o objeto `ScreenShareQuality` inteiro (do tempo dos presets "Nitidez/Equilibrado/...").
 * Só `height` e `fps` valem hoje; o resto (prioridade e teto de banda) é derivado. Quem já tinha uma escolha
 * continua com a mesma resolução e fps, sem perder nada; o próximo `saveScreenQuality` regrava no formato novo.
 */
const KEY = "spook:voice-screen-quality";

const isOf = <T extends number>(list: readonly T[], v: unknown): v is T =>
  list.some((x) => x === v);

export function loadScreenChoice(): ScreenChoice {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, unknown>;
    return {
      height: isOf(SCREEN_HEIGHTS, raw.height) ? raw.height : DEFAULT_SCREEN_CHOICE.height,
      fps: isOf(SCREEN_FPS, raw.fps) ? raw.fps : DEFAULT_SCREEN_CHOICE.fps,
    };
  } catch {
    return { ...DEFAULT_SCREEN_CHOICE };
  }
}

export function saveScreenChoice(c: ScreenChoice) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ height: c.height, fps: c.fps }));
  } catch {
    // armazenamento indisponível: vale só nesta sessão
  }
}

export const loadScreenQuality = (): ScreenShareQuality => qualityOf(loadScreenChoice());
export const saveScreenQuality = (q: ScreenShareQuality) => saveScreenChoice(q);
