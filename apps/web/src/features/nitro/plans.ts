// Matriz de planos (Grátis, Nitro, Nitro+) no cliente. Espelha `server/internal/plan` e
// `packages/shared/fixtures/plans.json` (há teste de contrato); o servidor é quem decide de verdade, isto só
// serve para esconder/travar a interface e evitar pedidos que seriam recusados.
import type { PlanLimits, PlanTier } from "@spook/shared";

export type { PlanLimits, PlanTier };

export const PLAN_TIERS = ["free", "nitro", "nitro_plus"] as const satisfies readonly PlanTier[];

export const PLAN_LIMITS: Record<PlanTier, PlanLimits> = {
  free: {
    screen_max_height: 720,
    screen_max_fps: 30,
    animated_avatar: false,
    animated_banner: false,
  },
  nitro: {
    screen_max_height: 1080,
    screen_max_fps: 60,
    animated_avatar: true,
    animated_banner: true,
  },
  nitro_plus: {
    screen_max_height: 1440,
    screen_max_fps: 60,
    animated_avatar: true,
    animated_banner: true,
  },
};

/** Plano pago? (`free` e ausente = não). */
export const isPaidTier = (tier: PlanTier | undefined | null): tier is "nitro" | "nitro_plus" =>
  tier === "nitro" || tier === "nitro_plus";

export const tierRank = (tier: PlanTier | undefined | null): number =>
  Math.max(0, PLAN_TIERS.indexOf(tier ?? "free"));

/** `tier` vale pelo menos `min`? */
export const tierAtLeast = (tier: PlanTier | undefined | null, min: PlanTier): boolean =>
  tierRank(tier) >= tierRank(min);

/** Limites de um plano; plano ausente ou desconhecido vale como grátis. */
export const limitsOf = (tier: PlanTier | undefined | null): PlanLimits =>
  PLAN_LIMITS[tier ?? "free"] ?? PLAN_LIMITS.free;

/** O avatar animado (GIF) da pessoa com este plano anima? A decisão é sempre pelo plano DO DONO da imagem. */
export const canAnimateAvatar = (tier: PlanTier | undefined | null): boolean =>
  limitsOf(tier).animated_avatar;

export const canAnimateBanner = (tier: PlanTier | undefined | null): boolean =>
  limitsOf(tier).animated_banner;

/** Menor plano que libera esta resolução e taxa de quadros. */
export function tierForScreen(height: number, fps: number): PlanTier {
  for (const tier of PLAN_TIERS) {
    const l = PLAN_LIMITS[tier];
    if (height <= l.screen_max_height && fps <= l.screen_max_fps) return tier;
  }
  return "nitro_plus";
}

/** Menor plano que libera GIF/WebP/APNG animado em avatar e banner. */
export const ANIMATED_TIER: PlanTier = "nitro";

/** Menor plano que libera esta altura de tela. */
export const tierForHeight = (height: number): PlanTier =>
  PLAN_TIERS.find((t) => height <= PLAN_LIMITS[t].screen_max_height) ?? "nitro_plus";

/** Menor plano que libera esta taxa de quadros. */
export const tierForFps = (fps: number): PlanTier =>
  PLAN_TIERS.find((t) => fps <= PLAN_LIMITS[t].screen_max_fps) ?? "nitro_plus";
