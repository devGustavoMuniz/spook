import { beforeEach, describe, expect, it } from "vitest";
import {
  clampScreenChoice,
  clampScreenQuality,
  DEFAULT_SCREEN_CHOICE,
  DEFAULT_SCREEN_QUALITY,
  estimateUplinkKbps,
  formatKbps,
  isHeavy,
  loadScreenChoice,
  loadScreenQuality,
  priorityFor,
  qualityOf,
  SCREEN_FPS,
  SCREEN_HEIGHTS,
  saveScreenChoice,
  saveScreenQuality,
} from "./screen-quality";

beforeEach(() => localStorage.clear());

describe("qualidade da tela: resolução e taxa de quadros", () => {
  it("o padrão é 1080p/30 fps (5 Mbps na tabela) e não é 'pesado'", () => {
    expect(DEFAULT_SCREEN_CHOICE).toEqual({ height: 1080, fps: 30 });
    expect(DEFAULT_SCREEN_QUALITY).toEqual({ height: 1080, fps: 30, priority: "motion" });
    expect(estimateUplinkKbps(DEFAULT_SCREEN_QUALITY)).toBe(5000);
    expect(isHeavy(DEFAULT_SCREEN_CHOICE)).toBe(false);
  });

  it("as opções são as do Discord: 720p, 1080p, 1440p e 15, 30, 60 fps", () => {
    expect([...SCREEN_HEIGHTS]).toEqual([720, 1080, 1440]);
    expect([...SCREEN_FPS]).toEqual([15, 30, 60]);
  });

  it("a prioridade é derivada: até 15 fps é detalhe; acima, movimento", () => {
    expect(priorityFor(15)).toBe("detail");
    expect(priorityFor(30)).toBe("motion");
    expect(priorityFor(60)).toBe("motion");
    expect(qualityOf({ height: 1440, fps: 15 })).toEqual({
      height: 1440,
      fps: 15,
      priority: "detail",
    });
  });

  it("a tabela de banda cobre todas as combinações e o teto manual (quando existe) manda", () => {
    for (const h of SCREEN_HEIGHTS)
      for (const f of SCREEN_FPS)
        expect(estimateUplinkKbps(qualityOf({ height: h, fps: f }))).toBeGreaterThan(0);
    expect(estimateUplinkKbps({ ...DEFAULT_SCREEN_QUALITY, maxBitrateKbps: 1200 })).toBe(1200);
    expect(estimateUplinkKbps(qualityOf({ height: 720, fps: 15 }))).toBe(1500);
  });

  it("1440p e 60 fps são marcados como pesados", () => {
    expect(isHeavy({ height: 1440, fps: 30 })).toBe(true);
    expect(isHeavy({ height: 720, fps: 60 })).toBe(true);
    expect(isHeavy({ height: 1080, fps: 15 })).toBe(false);
  });

  it("formata a banda", () => {
    expect(formatKbps(800)).toBe("800 kbps");
    expect(formatKbps(2500)).toBe("2,5 Mbps");
  });
});

describe("qualidade da tela: persistência", () => {
  it("sem nada salvo, usa o padrão", () => {
    expect(loadScreenChoice()).toEqual(DEFAULT_SCREEN_CHOICE);
    expect(loadScreenQuality()).toEqual(DEFAULT_SCREEN_QUALITY);
  });

  it("salva só resolução e fps e relê (a prioridade é derivada)", () => {
    saveScreenChoice({ height: 1440, fps: 15 });
    expect(JSON.parse(localStorage.getItem("spook:voice-screen-quality") ?? "")).toEqual({
      height: 1440,
      fps: 15,
    });
    expect(loadScreenQuality()).toEqual({ height: 1440, fps: 15, priority: "detail" });
  });

  it("migra a chave antiga (preset completo com prioridade e teto) para os campos novos", () => {
    localStorage.setItem(
      "spook:voice-screen-quality",
      JSON.stringify({ height: 720, fps: 60, priority: "detail", maxBitrateKbps: 6000 }),
    );
    expect(loadScreenChoice()).toEqual({ height: 720, fps: 60 });
    // a prioridade antiga (detail) e o teto manual (6000) são ignorados: derivados do fps e da tabela
    expect(loadScreenQuality()).toEqual({ height: 720, fps: 60, priority: "motion" });
    saveScreenQuality(loadScreenQuality());
    expect(JSON.parse(localStorage.getItem("spook:voice-screen-quality") ?? "")).toEqual({
      height: 720,
      fps: 60,
    });
  });

  it("valores inválidos voltam ao padrão, campo a campo", () => {
    localStorage.setItem(
      "spook:voice-screen-quality",
      JSON.stringify({ height: 4320, fps: 60, priority: "x" }),
    );
    expect(loadScreenChoice()).toEqual({ height: 1080, fps: 60 });
    localStorage.setItem("spook:voice-screen-quality", "lixo");
    expect(loadScreenChoice()).toEqual(DEFAULT_SCREEN_CHOICE);
  });
});

describe("qualidade da tela: limites do plano", () => {
  const free = { screen_max_height: 720, screen_max_fps: 30 };
  const nitro = { screen_max_height: 1080, screen_max_fps: 60 };
  const plus = { screen_max_height: 1440, screen_max_fps: 60 };

  it("reduz resolução e fps ao teto do plano, cada um por si", () => {
    expect(clampScreenChoice({ height: 1440, fps: 60 }, free)).toEqual({ height: 720, fps: 30 });
    expect(clampScreenChoice({ height: 1440, fps: 60 }, nitro)).toEqual({ height: 1080, fps: 60 });
    expect(clampScreenChoice({ height: 1440, fps: 60 }, plus)).toEqual({ height: 1440, fps: 60 });
    expect(clampScreenChoice({ height: 1080, fps: 15 }, free)).toEqual({ height: 720, fps: 15 });
  });

  it("o contrato da engine: nada muda dentro do limite; reduzido refaz prioridade e solta o teto manual", () => {
    const q = { height: 1080, fps: 30, priority: "motion", maxBitrateKbps: 9000 } as const;
    expect(clampScreenQuality(q, nitro)).toBe(q);
    expect(clampScreenQuality(q, free)).toEqual({ height: 720, fps: 30, priority: "motion" });
    expect(clampScreenQuality({ ...q, height: 1440, fps: 60 }, free)).toEqual({
      height: 720,
      fps: 30,
      priority: "motion",
    });
  });
});
