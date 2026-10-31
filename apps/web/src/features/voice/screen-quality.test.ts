import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SCREEN_QUALITY,
  estimateUplinkKbps,
  formatKbps,
  isHeavy,
  loadScreenQuality,
  presetIdOf,
  QUALITY_PRESETS,
  saveScreenQuality,
} from "./screen-quality";

beforeEach(() => localStorage.clear());

describe("qualidade da tela: presets e estimativa", () => {
  it("o padrão é o que o livekit-client já publicava (1080p, 15 fps, 2,5 Mbps) e não é 'pesado'", () => {
    expect(DEFAULT_SCREEN_QUALITY).toEqual({ height: 1080, fps: 15, priority: "detail" });
    expect(estimateUplinkKbps(DEFAULT_SCREEN_QUALITY)).toBe(2500);
    expect(isHeavy(DEFAULT_SCREEN_QUALITY)).toBe(false);
    expect(presetIdOf(DEFAULT_SCREEN_QUALITY)).toBe("sharp");
  });

  it("os quatro presets nomeados existem e os maiores são marcados como pesados", () => {
    expect(QUALITY_PRESETS.map((p) => p.label)).toEqual([
      "Nitidez — 1080p 15 fps",
      "Equilibrado — 1080p 30 fps",
      "Fluidez — 720p 60 fps",
      "Alta — 1440p 30 fps",
    ]);
    expect(QUALITY_PRESETS.map((p) => isHeavy(p.quality))).toEqual([false, true, true, true]);
  });

  it("o teto manual de bitrate manda na estimativa; qualquer ajuste manual deixa de ser preset", () => {
    const q = { ...DEFAULT_SCREEN_QUALITY, maxBitrateKbps: 1200 };
    expect(estimateUplinkKbps(q)).toBe(1200);
    expect(presetIdOf(q)).toBeNull();
    expect(presetIdOf({ ...DEFAULT_SCREEN_QUALITY, fps: 30 })).toBeNull();
  });

  it("formata a banda", () => {
    expect(formatKbps(800)).toBe("800 kbps");
    expect(formatKbps(2500)).toBe("2,5 Mbps");
  });
});

describe("qualidade da tela: persistência", () => {
  it("sem nada salvo, usa o padrão conservador", () => {
    expect(loadScreenQuality()).toEqual(DEFAULT_SCREEN_QUALITY);
  });

  it("salva e relê", () => {
    saveScreenQuality({ height: 1440, fps: 30, priority: "motion", maxBitrateKbps: 6000 });
    expect(loadScreenQuality()).toEqual({
      height: 1440,
      fps: 30,
      priority: "motion",
      maxBitrateKbps: 6000,
    });
  });

  it("valores inválidos voltam ao padrão, campo a campo", () => {
    localStorage.setItem(
      "spook:voice-screen-quality",
      JSON.stringify({ height: 4320, fps: 30, priority: "x", maxBitrateKbps: 99999 }),
    );
    expect(loadScreenQuality()).toEqual({ ...DEFAULT_SCREEN_QUALITY, fps: 30 });
    localStorage.setItem("spook:voice-screen-quality", "lixo");
    expect(loadScreenQuality()).toEqual(DEFAULT_SCREEN_QUALITY);
  });
});
