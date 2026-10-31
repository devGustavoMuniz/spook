// Prova o efeito do nível "Forte" SEM navegador: roda o worklet REAL do RNNoise (o mesmo arquivo e o mesmo
// WASM que o app serve) num contexto `vm` que imita o escopo global de um AudioWorklet, alimenta com
// "voz sintética + ruído de ventilador + cliques de teclado" e mede a energia antes e depois.
// O que NÃO prova: a qualidade com voz humana real e o custo de CPU no navegador (ver VALIDACAO-MANUAL.md).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const SR = 48_000;
const require = createRequire(import.meta.url);

type Processor = {
  process(input: Float32Array[][], output: Float32Array[][], params: object): boolean;
};

async function loadWorkletProcessor(): Promise<Processor> {
  const dir = require
    .resolve("@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js")
    .replace(/[\\/]rnnoise[\\/]workletProcessor\.js$/, "");
  const code = readFileSync(`${dir}/rnnoise/workletProcessor.js`, "utf8")
    // o arquivo é ESM só por causa desta referência
    .replaceAll("import.meta.url", '"file:///worklet.js"');
  const wasm = readFileSync(`${dir}/rnnoise.wasm`);
  const binary = wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength);

  let Registered: (new (o: object) => Processor) | undefined;
  const port = {
    onmessage: null,
    postMessage() {},
    addEventListener() {},
    removeEventListener() {},
  };
  const sandbox = {
    AudioWorkletProcessor: class {
      port = port;
    },
    registerProcessor: (_name: string, ctor: new (o: object) => Processor) => {
      Registered = ctor;
    },
    sampleRate: SR,
    console,
    performance,
    TextDecoder,
    TextEncoder,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    Float32Array,
    Uint8Array,
    ArrayBuffer,
  };
  vm.runInNewContext(code, sandbox);
  if (!Registered) throw new Error("o worklet não registrou o processador");
  const proc = new Registered({ processorOptions: { maxChannels: 1, wasmBinary: binary } });
  // o WASM instancia de forma assíncrona; antes disso o processador devolve silêncio
  await new Promise((r) => setTimeout(r, 300));
  return proc;
}

/** PRNG determinístico (o teste não pode ser instável). */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32 - 0.5;
  };
}

/** Ruído de ventilador (passa-baixas) + chiado + cliques de teclado. */
function noiseTrack(seconds: number): Float32Array {
  const n = SR * seconds;
  const r = rng(1);
  const out = new Float32Array(n);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    lp += 0.15 * (r() * 2 - lp);
    out[i] = lp * 0.08 + r() * 0.02;
  }
  for (let k = 0; k < 12; k++) {
    const p = Math.floor((k * 0.31 + 0.1) * SR);
    for (let i = 0; i < 300; i++) out[p + i] = (out[p + i] ?? 0) + r() * 0.3 * Math.exp(-i / 60);
  }
  return out;
}

/** "Voz" sintética: harmônicos de ~130 Hz com formantes e envelope silábico (~3 sílabas/s), a partir de `from` s. */
function voiceTrack(seconds: number, from: number): Float32Array {
  const n = SR * seconds;
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = Math.floor(from * SR); i < n; i++) {
    const t = i / SR;
    const f0 = 130 + 25 * Math.sin(2 * Math.PI * 0.7 * t);
    phase += (2 * Math.PI * f0) / SR;
    const env = Math.sqrt(Math.max(0, Math.sin(2 * Math.PI * 3 * t)));
    let s = 0;
    for (let h = 1; h <= 30; h++) {
      const f = h * f0;
      const form =
        Math.exp(-(((f - 700) / 300) ** 2)) +
        0.6 * Math.exp(-(((f - 1500) / 400) ** 2)) +
        0.3 * Math.exp(-(((f - 2600) / 500) ** 2));
      s += (form * Math.sin(h * phase)) / h ** 0.3;
    }
    out[i] = 0.12 * env * s;
  }
  return out;
}

function run(proc: Processor, input: Float32Array): Float32Array {
  const out = new Float32Array(input.length);
  const a = new Float32Array(128);
  const b = new Float32Array(128);
  for (let i = 0; i + 128 <= input.length; i += 128) {
    a.set(input.subarray(i, i + 128));
    proc.process([[a]], [[b]], {});
    out.set(b, i);
  }
  return out;
}

const energy = (x: Float32Array, from: number, to: number) => {
  let e = 0;
  for (let i = Math.floor(from * SR); i < Math.floor(to * SR); i++) e += (x[i] ?? 0) ** 2;
  return e / ((to - from) * SR);
};
const db = (a: number, b: number) => 10 * Math.log10(a / b);

describe("RNNoise (nível Forte): efeito sobre sinal sintético", () => {
  it("reduz a energia do ruído e preserva a voz", async () => {
    const seconds = 4;
    const voiceFrom = 1.5;
    const noise = noiseTrack(seconds);
    const voice = voiceTrack(seconds, voiceFrom);
    const mix = noise.map((v, i) => v + (voice[i] ?? 0));

    const out = run(await loadWorkletProcessor(), mix);

    // 1) trecho só com ruído (0,3 s a 1,4 s): o modelo já se adaptou e cala o ventilador e os cliques
    const noiseReduction = db(energy(mix, 0.3, 1.4), energy(out, 0.3, 1.4));
    // 2) trecho com voz (2 s a 4 s): a energia da saída fica perto da voz limpa (sem apagar a fala)
    const voiceKept = db(energy(out, 2, 4), energy(voice, 2, 4));
    console.info(
      `RNNoise sintético: ruído -${noiseReduction.toFixed(1)} dB; voz ${voiceKept.toFixed(1)} dB vs. limpa`,
    );
    expect(noiseReduction).toBeGreaterThan(8);
    expect(Math.abs(voiceKept)).toBeLessThan(3);
  });
});
