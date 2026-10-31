// Porta de ruído (noise gate) do microfone, executada num AudioWorklet. Roda DEPOIS da supressão de ruído
// (RNNoise) no mesmo grafo: ver `noise-processor.ts`. Arquivo JS puro e autocontido porque o navegador o carrega
// por `audioWorklet.addModule(url)` (o Vite o serve como asset, `?url`); os testes (`noise-gate.test.ts`) o
// executam num contexto `vm` que imita o escopo global de um worklet.
//
// Algoritmo (decisão em SPEC.md 5.5, "Adicional: volume por pessoa, teste de microfone e qualidade da tela"):
// - detector: potência suavizada (um polo, ~10 ms) do canal 0, em dBFS;
// - lookahead de 10 ms: o áudio sai atrasado, então a porta abre ANTES de o início da palavra chegar à saída;
// - attack 5 ms (< lookahead), hold 200 ms, release 80 ms: o ganho é uma rampa LINEAR (sem degraus: sem cliques);
// - histerese de 4 dB: abre acima do limiar, só começa a fechar abaixo de (limiar - 4 dB) e depois do hold;
// - modo `manual`: o limiar vem da configuração; modo `auto`: limiar = piso de ruído estimado + 12 dB, com o piso
//   seguindo o MÍNIMO do nível (cai rápido, sobe devagar; mais devagar ainda com a porta aberta, para a fala
//   não puxar o piso para cima); modo `off`: só mede (o sinal passa, atrasado, com ganho 1).
// Mensagens: entrada `{type:"config", mode, thresholdDb}`; saída `{type:"level", db, open}` a cada ~50 ms.

const LOOKAHEAD_S = 0.01;
const ATTACK_S = 0.005;
const HOLD_S = 0.2;
const RELEASE_S = 0.08;
const DETECTOR_TAU_S = 0.01;
const HYSTERESIS_DB = 4;
const AUTO_MARGIN_DB = 12;
const AUTO_MIN_THRESHOLD_DB = -65;
const AUTO_MAX_THRESHOLD_DB = -25;
const FLOOR_INIT_DB = -55;
const FLOOR_MIN_DB = -90;
const FLOOR_DOWN_DB_S = 30;
const FLOOR_UP_CLOSED_DB_S = 6;
const FLOOR_UP_OPEN_DB_S = 2;
const REPORT_EVERY_S = 0.05;
const SILENCE_POWER = 1e-12;

const toPower = (db) => 10 ** (db / 10);
const toDb = (power) => 10 * Math.log10(power + SILENCE_POWER);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

class SpookGate extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options?.processorOptions || {};
    this.mode = "off";
    this.thresholdDb = -50;
    this.configure(o);
    this.sr = sampleRate;
    this.delayLen = Math.max(1, Math.round(LOOKAHEAD_S * this.sr));
    this.delays = [];
    this.writePos = 0;
    this.detAlpha = 1 - Math.exp(-1 / (DETECTOR_TAU_S * this.sr));
    this.holdSamples = Math.round(HOLD_S * this.sr);
    this.upStep = 1 / (ATTACK_S * this.sr);
    this.downStep = 1 / (RELEASE_S * this.sr);
    this.env = 0;
    this.gain = 0;
    this.open = false;
    this.holdLeft = 0;
    this.floorDb = FLOOR_INIT_DB;
    this.openPow = toPower(this.effectiveThresholdDb());
    this.closePow = toPower(this.effectiveThresholdDb() - HYSTERESIS_DB);
    this.sinceReport = 0;
    this.port.onmessage = (e) => {
      if (e.data && e.data.type === "config") this.configure(e.data);
    };
  }

  configure(c) {
    if (c.mode === "off" || c.mode === "auto" || c.mode === "manual") this.mode = c.mode;
    if (typeof c.thresholdDb === "number" && Number.isFinite(c.thresholdDb))
      this.thresholdDb = clamp(c.thresholdDb, -90, -5);
  }

  effectiveThresholdDb() {
    if (this.mode === "auto")
      return clamp(this.floorDb + AUTO_MARGIN_DB, AUTO_MIN_THRESHOLD_DB, AUTO_MAX_THRESHOLD_DB);
    return this.thresholdDb;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    if (!input || input.length === 0) {
      // sem sinal de entrada: silêncio, e o detector decai
      for (const ch of output) ch.fill(0);
      return true;
    }
    const n = output[0].length;
    const detector = input[0];
    while (this.delays.length < output.length) this.delays.push(new Float32Array(this.delayLen));
    const off = this.mode === "off";
    const dt = n / this.sr;

    // limiares valem para o bloco todo (o piso muda devagar)
    const thDb = this.effectiveThresholdDb();
    this.openPow = toPower(thDb);
    this.closePow = toPower(thDb - HYSTERESIS_DB);

    let wp = this.writePos;
    for (let i = 0; i < n; i++) {
      const x = detector[i] || 0;
      this.env += this.detAlpha * (x * x - this.env);

      if (off) {
        this.open = true;
        this.holdLeft = this.holdSamples;
      } else if (this.env >= this.openPow) {
        this.open = true;
        this.holdLeft = this.holdSamples;
      } else if (this.open) {
        if (this.env >= this.closePow) this.holdLeft = this.holdSamples;
        else if (--this.holdLeft <= 0) this.open = false;
      }
      this.gain = this.open
        ? Math.min(1, this.gain + this.upStep)
        : Math.max(0, this.gain - this.downStep);

      const rp = wp;
      wp = wp + 1 === this.delayLen ? 0 : wp + 1;
      for (let c = 0; c < output.length; c++) {
        const buf = this.delays[c];
        const src = input[c] || detector;
        const delayed = buf[rp];
        buf[rp] = src[i] || 0;
        output[c][i] = delayed * this.gain;
      }
    }
    this.writePos = wp;

    const levelDb = toDb(this.env);
    if (this.mode === "auto") this.trackFloor(levelDb, dt);

    this.sinceReport += dt;
    if (this.sinceReport >= REPORT_EVERY_S) {
      this.sinceReport = 0;
      this.port.postMessage({ type: "level", db: levelDb, open: this.open });
    }
    return true;
  }

  /** Piso de ruído por estatística de mínimos: desce rápido, sobe devagar (mais devagar com a porta aberta). */
  trackFloor(levelDb, dt) {
    if (levelDb <= this.floorDb) {
      this.floorDb = Math.max(FLOOR_MIN_DB, Math.max(levelDb, this.floorDb - FLOOR_DOWN_DB_S * dt));
    } else {
      const rate = this.open ? FLOOR_UP_OPEN_DB_S : FLOOR_UP_CLOSED_DB_S;
      this.floorDb = Math.min(levelDb, this.floorDb + rate * dt);
    }
  }
}

registerProcessor("spook-gate", SpookGate);
