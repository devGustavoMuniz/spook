import { describe, expect, it } from "vitest";
import fixture from "../../../../../packages/shared/fixtures/plans.json";
import {
  canAnimateAvatar,
  canAnimateBanner,
  isPaidTier,
  limitsOf,
  PLAN_LIMITS,
  PLAN_TIERS,
  tierAtLeast,
  tierForFps,
  tierForHeight,
  tierForScreen,
} from "./plans";

describe("matriz de planos: contrato com a fixture do servidor", () => {
  it("plans.ts == packages/shared/fixtures/plans.json (planos, ordem e limites)", () => {
    expect([...PLAN_TIERS]).toEqual(fixture.tiers);
    expect(PLAN_LIMITS).toEqual(fixture.limits);
  });

  it("valores decididos pelo dono", () => {
    expect(PLAN_LIMITS.free).toMatchObject({ screen_max_height: 720, screen_max_fps: 30 });
    expect(PLAN_LIMITS.nitro).toMatchObject({ screen_max_height: 1080, screen_max_fps: 60 });
    expect(PLAN_LIMITS.nitro_plus).toMatchObject({ screen_max_height: 1440, screen_max_fps: 60 });
    expect(PLAN_LIMITS.free.animated_avatar).toBe(false);
    expect(PLAN_LIMITS.nitro.animated_banner).toBe(true);
  });
});

describe("ajudantes de plano", () => {
  it("ausente vale grátis; ordem free < nitro < nitro_plus", () => {
    expect(limitsOf(undefined)).toEqual(PLAN_LIMITS.free);
    expect(isPaidTier(undefined)).toBe(false);
    expect(isPaidTier("free")).toBe(false);
    expect(isPaidTier("nitro_plus")).toBe(true);
    expect(tierAtLeast("nitro", "nitro")).toBe(true);
    expect(tierAtLeast("nitro", "nitro_plus")).toBe(false);
    expect(tierAtLeast(undefined, "nitro")).toBe(false);
  });

  it("a animação do avatar e do banner é pelo plano do dono", () => {
    expect(canAnimateAvatar(undefined)).toBe(false);
    expect(canAnimateAvatar("free")).toBe(false);
    expect(canAnimateAvatar("nitro")).toBe(true);
    expect(canAnimateBanner("nitro_plus")).toBe(true);
    expect(canAnimateBanner("free")).toBe(false);
  });

  it("menor plano para cada resolução e taxa de quadros", () => {
    expect(tierForHeight(720)).toBe("free");
    expect(tierForHeight(1080)).toBe("nitro");
    expect(tierForHeight(1440)).toBe("nitro_plus");
    expect(tierForFps(15)).toBe("free");
    expect(tierForFps(30)).toBe("free");
    expect(tierForFps(60)).toBe("nitro");
    expect(tierForScreen(1080, 30)).toBe("nitro");
    expect(tierForScreen(1440, 60)).toBe("nitro_plus");
  });
});
