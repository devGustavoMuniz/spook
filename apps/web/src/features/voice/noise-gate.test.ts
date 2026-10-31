// Prova a porta de ruído SEM navegador: executa o worklet REAL (`gate-worklet.js`, o mesmo arquivo que o app
// serve) num contexto `vm` que imita o escopo global de um AudioWorklet e processa blocos de 128 amostras.
// O que NÃO prova: o ajuste fino com voz humana e microfone reais (ver VALIDACAO-MANUAL.md).
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const SR = 48_000;
const BLOCK = 128;

type Report = { db: number; open: boolean };
type Gate = {
  process(input: Float32Array[][], output: Float32Array[][]): boolean;
  port: { onmessage: ((e: { data: unknown }) => void) | null };
};

function createGate(config: { mode: "off" | "auto" | "manual"; thresholdDb?: number }) {
  const code = readFileSync(`${__dirname}/gate-worklet.js`, "utf8");
  const reports: Report[] = [];
  let Registered: (new (o: object) => Gate) | undefined;
  const port = {
    onmessage: null as ((e: { data: unknown }) => void) | null,
    postMessage(m: { type: string } & Report) {
      if (m.type === "level") reports.push({ db: m.db, open: m.open });
    },
  };
  vm.runInNewContext(code, {
    AudioWorkletProcessor: class {
      port = port;
    },
    registerProcessor: (_n: string, c: new (o: object) => Gate) => {
      Registered = c;
    },
    sampleRate: SR,
    Float32Array,
    Math,
    Number,
  });
  if (!Registered) throw new Error("o worklet não registrou o processador");
  const gate = new Registered({ processorOptions: { thresholdDb: -50, ...config } });
  return { gate, reports };
}

/** Passa `signal` pela porta e devolve a saída (mesmo tamanho). */
function run(gate: Gate, signal: Float32Array): Float32Array {
  const out = new Float32Array(signal.length);
  for (let i = 0; i + BLOCK <= signal.length; i += BLOCK) {
    const input = [[signal.subarray(i, i + BLOCK)]];
    const output = [[new Float32Array(BLOCK)]];
    gate.process(input as Float32Array[][], output as Float32Array[][]);
    out.set(output[0]?.[0] ?? [], i);
  }
  return out;
}

const dbToAmp = (db: number) => 10 ** (db / 20);
const rmsDb = (s: Float32Array) => {
  let acc = 0;
  for (const v of s) acc += v * v;
  return 10 * Math.log10(acc / Math.max(1, s.length) + 1e-20);
};

/** Ruído branco determinístico (LCG) com RMS `db`. */
function noise(seconds: number, db: number, seed = 1): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR));
  let s = seed;
  for (let i = 0; i < out.length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = ((s / 0xffffffff) * 2 - 1) * Math.sqrt(3) * dbToAmp(db);
  }
  return out;
}

/** "Voz" sintética: fundamental de 150 Hz com harmônicos, RMS `db`. */
function voice(seconds: number, db: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    out[i] = Math.sin(2 * Math.PI * 150 * t) + 0.5 * Math.sin(2 * Math.PI * 300 * t);
  }
  const gain = dbToAmp(db) / dbToAmp(rmsDb(out));
  for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) * gain;
  return out;
}

const concat = (...parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const seg = (s: Float32Array, fromS: number, toS: number) =>
  s.subarray(Math.round(fromS * SR), Math.round(toS * SR));

describe("porta de ruído: modo manual", () => {
  it("fecha com ruído abaixo do limiar (silêncio na saída)", () => {
    const { gate } = createGate({ mode: "manual", thresholdDb: -45 });
    const out = run(gate, noise(2, -60));
    expect(rmsDb(seg(out, 0.5, 2))).toBeLessThan(-100);
  });

  it("abre com voz acima do limiar e deixa passar o nível original", () => {
    const { gate } = createGate({ mode: "manual", thresholdDb: -45 });
    const input = concat(noise(1, -60), voice(1, -25));
    const out = run(gate, input);
    const gain = rmsDb(seg(out, 1.1, 2)) - rmsDb(seg(input, 1.1, 2));
    expect(Math.abs(gain)).toBeLessThan(0.5);
  });

  it("attack com lookahead: o início da palavra sai inteiro (sem cortar a primeira sílaba)", () => {
    const { gate } = createGate({ mode: "manual", thresholdDb: -45 });
    const input = concat(noise(1, -70), voice(0.5, -20));
    const out = run(gate, input);
    // a saída é a entrada atrasada em 10 ms: compara o 1o trecho de 30 ms da voz, depois do atraso
    const onset = SR;
    const delay = Math.round(0.01 * SR);
    const ref = input.subarray(onset, onset + 1440);
    const got = out.subarray(onset + delay, onset + delay + 1440);
    const lost = rmsDb(ref) - rmsDb(got);
    expect(lost).toBeLessThan(1); // < 1 dB perdido nos primeiros 30 ms
  });

  it("hold: continua aberta ~200 ms depois do fim da voz e fecha em seguida", () => {
    const { gate, reports } = createGate({ mode: "manual", thresholdDb: -45 });
    run(gate, concat(noise(0.5, -70), voice(1, -20), noise(1, -70)));
    // a voz acaba em t = 1,5 s; relatórios a cada ~50 ms
    const t = (r: Report) => reports.indexOf(r) * 0.05;
    const lastOpen =
      reports
        .filter((r) => r.open)
        .map(t)
        .pop() ?? 0;
    expect(lastOpen - 1.5).toBeGreaterThan(0.12);
    expect(lastOpen - 1.5).toBeLessThan(0.4);
    expect(reports[reports.length - 1]?.open).toBe(false);
  });

  it("a abertura e o fechamento não geram cliques (o salto entre amostras não passa do que a própria voz tem)", () => {
    const { gate } = createGate({ mode: "manual", thresholdDb: -45 });
    const input = concat(noise(0.3, -70), voice(0.6, -20), noise(0.6, -70));
    const out = run(gate, input);
    const maxStep = (s: Float32Array) => {
      let m = 0;
      for (let i = 1; i < s.length; i++) m = Math.max(m, Math.abs((s[i] ?? 0) - (s[i - 1] ?? 0)));
      return m;
    };
    const voiceStep = maxStep(voice(0.5, -20));
    expect(maxStep(out)).toBeLessThan(voiceStep * 1.3);
  });

  it("mudar o limiar na hora (mensagem) vale sem recriar o processador", () => {
    const { gate } = createGate({ mode: "manual", thresholdDb: -60 });
    const noiseSig = noise(1, -50);
    expect(rmsDb(seg(run(gate, noiseSig), 0.5, 1))).toBeGreaterThan(-55); // -50 > -60: aberta
    gate.port.onmessage?.({ data: { type: "config", mode: "manual", thresholdDb: -30 } });
    const out = run(gate, noise(1.5, -50));
    expect(rmsDb(seg(out, 1, 1.5))).toBeLessThan(-100); // -50 < -30: fechada
  });
});

describe("porta de ruído: modo desligado", () => {
  it("deixa tudo passar (só atrasa) e continua medindo o nível", () => {
    const { gate, reports } = createGate({ mode: "off" });
    const input = noise(1, -70);
    const out = run(gate, input);
    expect(Math.abs(rmsDb(seg(out, 0.3, 1)) - rmsDb(seg(input, 0.3, 1)))).toBeLessThan(0.5);
    expect(reports.length).toBeGreaterThan(10);
    expect(reports.every((r) => r.open)).toBe(true);
    expect(Math.abs((reports[reports.length - 1]?.db ?? 0) - -70)).toBeLessThan(3);
  });
});

describe("porta de ruído: modo automático", () => {
  it("aprende o piso de ruído: fecha com o ruído e abre com a voz", () => {
    const { gate } = createGate({ mode: "auto" });
    const input = concat(noise(3, -60), voice(1, -30), noise(1, -60, 7));
    const out = run(gate, input);
    expect(rmsDb(seg(out, 2, 3))).toBeLessThan(-100);
    expect(Math.abs(rmsDb(seg(out, 3.1, 4)) - rmsDb(seg(input, 3.1, 4)))).toBeLessThan(0.5);
    expect(rmsDb(seg(out, 4.8, 5))).toBeLessThan(-100);
  });

  it("acompanha o piso: com um ventilador mais alto, abre no começo e depois passa a fechar", () => {
    const { gate, reports } = createGate({ mode: "auto" });
    const input = concat(noise(3, -60), noise(14, -40, 3));
    run(gate, input);
    const at = (s: number) => reports[Math.min(reports.length - 1, Math.round(s / 0.05))];
    expect(at(3.5)?.open).toBe(true); // o ruído novo, mais alto, ainda abre a porta
    expect(at(16.5)?.open).toBe(false); // o piso subiu e a porta fechou para ele
  });

  it("depois de adaptar, a voz bem acima do ruído continua passando", () => {
    const { gate } = createGate({ mode: "auto" });
    const input = concat(noise(3, -60), noise(14, -40, 3), voice(1, -20));
    const out = run(gate, input);
    expect(Math.abs(rmsDb(seg(out, 17.1, 18)) - rmsDb(seg(input, 17.1, 18)))).toBeLessThan(0.5);
  });
});
