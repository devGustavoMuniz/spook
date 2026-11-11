import { describe, expect, it } from "vitest";
import {
  LocalSpeakingDetector,
  mergeSpeaking,
  SPEAKING_HOLD_MS,
  SpeakerHold,
  sameSet,
} from "./speaking";

describe("SpeakerHold (anti-pisca do servidor)", () => {
  it("acende imediatamente", () => {
    const h = new SpeakerHold();
    h.push(["a"], 1000);
    expect(h.active(1000)).toEqual(["a"]);
  });

  it("só apaga depois de 600 ms sem aparecer", () => {
    const h = new SpeakerHold();
    h.push(["a"], 1000);
    h.push([], 1200); // atualização do servidor sem "a": segura
    expect(h.active(1200)).toEqual(["a"]);
    expect(h.active(1599)).toEqual(["a"]);
    expect(h.active(1000 + SPEAKING_HOLD_MS)).toEqual([]);
  });

  it("reaparecer renova o hold e cada identidade tem o seu", () => {
    const h = new SpeakerHold();
    h.push(["a", "b"], 0);
    h.push(["a"], 200);
    expect(h.active(650).sort()).toEqual(["a"]);
    expect(h.nextExpiry()).toBe(800);
    h.clear();
    expect(h.nextExpiry()).toBeNull();
  });
});

const loud = { db: -30, gateOpen: true };
const quiet = { db: -70, gateOpen: false };

describe("LocalSpeakingDetector", () => {
  it("só acende depois de ~60 ms contínuos acima do limiar", () => {
    const d = new LocalSpeakingDetector({ gate: false });
    expect(d.update(loud, 0)).toBe(false);
    expect(d.update(loud, 50)).toBe(false);
    expect(d.update(loud, 100)).toBe(true);
  });

  it("um estalo curto (abaixo de 60 ms) não acende", () => {
    const d = new LocalSpeakingDetector({ gate: false });
    d.update(loud, 0);
    d.update(quiet, 40);
    expect(d.update(loud, 80)).toBe(false);
  });

  it("apaga só 600 ms depois da última leitura acima do limiar", () => {
    const d = new LocalSpeakingDetector({ gate: false });
    d.update(loud, 0);
    d.update(loud, 100);
    expect(d.update(quiet, 150)).toBe(true);
    expect(d.update(quiet, 699)).toBe(true);
    expect(d.update(quiet, 701)).toBe(false);
    expect(d.nextExpiry()).toBeNull();
  });

  it("histerese de 4 dB: aceso, -53 dB ainda conta; apagado, -53 dB não acende", () => {
    const mid = { db: -53, gateOpen: true };
    const off = new LocalSpeakingDetector({ gate: false });
    off.update(mid, 0);
    expect(off.update(mid, 100)).toBe(false);

    const on = new LocalSpeakingDetector({ gate: false });
    on.update(loud, 0);
    on.update(loud, 100);
    for (let t = 150; t < 1000; t += 50) on.update(mid, t);
    expect(on.speaking).toBe(true);
    on.update({ db: -55, gateOpen: true }, 1000);
    expect(on.tick(1700)).toBe(false);
  });

  it("com porta ligada exige a porta aberta (limiar -55 dB)", () => {
    const d = new LocalSpeakingDetector({ gate: true });
    const closed = { db: -40, gateOpen: false };
    d.update(closed, 0);
    expect(d.update(closed, 100)).toBe(false);
    const open = { db: -56, gateOpen: true };
    d.update(open, 200);
    expect(d.update(open, 300)).toBe(false);
    const ok = { db: -50, gateOpen: true };
    d.update(ok, 400);
    expect(d.update(ok, 500)).toBe(true);
  });

  it("tick apaga sem leituras novas (o evento parou)", () => {
    const d = new LocalSpeakingDetector({ gate: false });
    d.update(loud, 0);
    d.update(loud, 100);
    expect(d.nextExpiry()).toBe(700);
    expect(d.tick(699)).toBe(true);
    expect(d.tick(700)).toBe(false);
  });

  it("nível não finito (NaN) não acende", () => {
    const d = new LocalSpeakingDetector({ gate: false });
    d.update({ db: Number.NaN, gateOpen: true }, 0);
    expect(d.update({ db: Number.NaN, gateOpen: true }, 100)).toBe(false);
  });
});

describe("mergeSpeaking", () => {
  it("é o OU do servidor com a leitura local", () => {
    expect([...mergeSpeaking(["b"], true, "me", false)].sort()).toEqual(["b", "me"]);
    expect([...mergeSpeaking(["b", "me"], false, "me", false)].sort()).toEqual(["b", "me"]);
  });

  it("mudo nunca acende e apaga o que o servidor ainda mostrava", () => {
    expect([...mergeSpeaking(["me", "b"], true, "me", true)]).toEqual(["b"]);
  });

  it("sem identidade própria só vale o servidor", () => {
    expect([...mergeSpeaking(["b"], true, null, false)]).toEqual(["b"]);
  });

  it("sameSet compara por conteúdo", () => {
    expect(sameSet(new Set(["a", "b"]), new Set(["b", "a"]))).toBe(true);
    expect(sameSet(new Set(["a"]), new Set(["a", "b"]))).toBe(false);
  });
});

describe("fala contínua não pisca", () => {
  it("lacunas de até 500 ms (vogal sustentada) não apagam o anel local", () => {
    const d = new LocalSpeakingDetector({ gate: false });
    const loud = { db: -30, gateOpen: true };
    const quiet = { db: -80, gateOpen: false };
    d.update(loud, 0);
    d.update(loud, 100);
    expect(d.speaking).toBe(true);
    // fala contínua com quedas de nível de 450 ms entre picos: nunca apaga
    for (let t = 150; t < 4000; t += 500) {
      expect(d.update(quiet, t + 450 - 50)).toBe(true);
      expect(d.update(loud, t + 450)).toBe(true);
    }
  });

  it("lacunas do servidor de até 500 ms não apagam o anel remoto", () => {
    const h = new SpeakerHold();
    for (let t = 0; t < 4000; t += 500) {
      h.push(["a"], t);
      h.push([], t + 200);
      expect(h.active(t + 499)).toEqual(["a"]);
    }
  });
});
