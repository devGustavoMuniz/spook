import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PERSON_VOLUME,
  effectiveVolume,
  personVolumeOf,
  useParticipantVolumeStore,
} from "./participant-volume";

const store = () => useParticipantVolumeStore.getState();

beforeEach(() => {
  localStorage.clear();
  store().reload();
});

describe("volume por pessoa: persistência", () => {
  it("grava por id de usuário e sobrevive a recarregar", () => {
    store().set("7", { voice: 0.4 });
    store().set("7", { screen: 0.2 });
    store().reload();
    expect(personVolumeOf(store().byUser, "7")).toEqual({ voice: 0.4, screen: 0.2, muted: false });
    expect(personVolumeOf(store().byUser, "8")).toEqual(DEFAULT_PERSON_VOLUME);
  });

  it("voltar ao padrão apaga a entrada (o armazenamento não cresce à toa)", () => {
    store().set("7", { voice: 0.4 });
    store().set("7", { voice: 1 });
    expect(JSON.parse(localStorage.getItem("spook:voice-participant-volumes") ?? "{}")).toEqual({});
  });

  it("silenciar só para mim guarda o volume anterior", () => {
    store().set("7", { voice: 0.6 });
    store().set("7", { muted: true });
    expect(personVolumeOf(store().byUser, "7")).toEqual({ voice: 0.6, screen: 1, muted: true });
    store().set("7", { muted: false });
    expect(personVolumeOf(store().byUser, "7").voice).toBe(0.6);
  });

  it("dados corrompidos são ignorados; valores fora da faixa são limitados", () => {
    localStorage.setItem("spook:voice-participant-volumes", "lixo");
    store().reload();
    expect(store().byUser).toEqual({});
    localStorage.setItem(
      "spook:voice-participant-volumes",
      JSON.stringify({ "7": { voice: 9, screen: -3, muted: "sim" }, "8": 5 }),
    );
    store().reload();
    expect(store().byUser).toEqual({ "7": { voice: 2, screen: 0, muted: false } });
  });
});

describe("volume efetivo", () => {
  it("silenciado vale 0 e o resto é limitado ao máximo da engine", () => {
    expect(effectiveVolume({ voice: 0.5, screen: 1, muted: false }, "voice", 1)).toBe(0.5);
    expect(effectiveVolume({ voice: 1.8, screen: 1, muted: false }, "voice", 1)).toBe(1);
    expect(effectiveVolume({ voice: 1.8, screen: 1, muted: false }, "voice", 2)).toBe(1.8);
    expect(effectiveVolume({ voice: 0.5, screen: 1, muted: true }, "screen", 1)).toBe(0);
  });
});
