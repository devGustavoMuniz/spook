// Supressão de ruído "Forte" (IA, gratuita e local): RNNoise (Xiph.Org, BSD-3-Clause) compilado para WASM e
// executado num AudioWorklet, pelo pacote @sapphi-red/web-noise-suppressor (MIT). Decisão e comparação com o
// DeepFilterNet3 em SPEC.md 5.5 ("Adicional: ruído e eco (web)").
//
// O módulo NÃO importa `livekit-client` (só `web-engine.ts` pode): ele expõe um processador com o formato de
// `TrackProcessor` da lib (name/init/restart/destroy/processedTrack), que a engine entrega ao track.
// Tudo é carregado sob demanda: este arquivo só entra no bundle quando alguém escolhe o nível "Forte", e os
// assets (worklet + WASM, ~220 kB) saem do build do próprio app (`?url`), nunca de um CDN.
import rnnoiseWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseSimdWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";
import rnnoiseWorkletUrl from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";

/** O RNNoise trabalha a 48 kHz (quadros de 480 amostras); o contexto de áudio é criado nessa taxa. */
const SAMPLE_RATE = 48_000;
/** Limite para baixar e iniciar o modelo; passou disso, rebaixa para "Padrão". */
export const LOAD_TIMEOUT_MS = 20_000;

// ---- Medidor de carga ----

export type LoadLevel = "ok" | "high";

/**
 * Detecta processamento lento sem acesso ao tempo do worklet (que o navegador não expõe): se a thread de áudio
 * não dá conta, o relógio do `AudioContext` anda MENOS que o relógio de parede. Compara os dois a cada
 * `tick()`; `ratio < threshold` = janela lenta. Uma janela lenta marca carga alta (aviso na interface);
 * `strikes` janelas seguidas disparam `onSlow` (rebaixa para "Padrão").
 */
export class LoadMonitor {
  private lastWall: number;
  private lastCtx: number;
  private slowWindows = 0;
  private level: LoadLevel = "ok";

  constructor(
    private readonly clock: { wall: () => number; ctx: () => number; running: () => boolean },
    private readonly handlers: { onLoad: (l: LoadLevel) => void; onSlow: () => void },
    private readonly opts: { threshold: number; strikes: number } = { threshold: 0.9, strikes: 3 },
  ) {
    this.lastWall = clock.wall();
    this.lastCtx = clock.ctx();
  }

  tick() {
    const wall = this.clock.wall();
    const ctx = this.clock.ctx();
    const dWall = wall - this.lastWall;
    const dCtx = ctx - this.lastCtx;
    this.lastWall = wall;
    this.lastCtx = ctx;
    // Contexto suspenso (política de autoplay, aba congelada) não prova lentidão.
    if (!this.clock.running() || dWall <= 0) return;
    const slow = dCtx / dWall < this.opts.threshold;
    this.slowWindows = slow ? this.slowWindows + 1 : 0;
    const next: LoadLevel = slow ? "high" : "ok";
    if (next !== this.level) {
      this.level = next;
      this.handlers.onLoad(next);
    }
    if (this.slowWindows >= this.opts.strikes) {
      this.slowWindows = 0;
      this.handlers.onSlow();
    }
  }
}

// ---- Assets (cache de módulo) ----

let wasmBinary: Promise<ArrayBuffer> | null = null;

async function loadWasm(): Promise<ArrayBuffer> {
  if (!wasmBinary) {
    wasmBinary = (async () => {
      const { loadRnnoise } = await import("@sapphi-red/web-noise-suppressor");
      return loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl });
    })();
    // Falha não fica em cache: a próxima tentativa baixa de novo.
    wasmBinary.catch(() => {
      wasmBinary = null;
    });
  }
  return wasmBinary;
}

/** Só para testes. */
export function resetNoiseProcessorCache() {
  wasmBinary = null;
}

// ---- Processador ----

export type NoiseProcessorHooks = {
  onLoad?: (load: LoadLevel) => void;
  /** O processamento não acompanha o tempo real: quem usa deve rebaixar para "Padrão". */
  onSlow?: () => void;
};

type RnnoiseNode = { connect(n: AudioNode): void; disconnect(): void; destroy(): void };

/** Formato mínimo do `TrackProcessor` do livekit-client para áudio (a engine web o repassa à lib). */
export class RnnoiseTrackProcessor {
  readonly name = "spook-rnnoise";
  processedTrack?: MediaStreamTrack;

  private ctx: AudioContext | null = null;
  private node: RnnoiseNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private dest: MediaStreamAudioDestinationNode | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly hooks: NoiseProcessorHooks = {}) {}

  async init(opts: { track: MediaStreamTrack }): Promise<void> {
    await this.build(opts.track);
  }

  /** A lib reinicia o processador quando a captura é recriada (novo track de entrada). */
  async restart(opts: { track: MediaStreamTrack }): Promise<void> {
    this.teardown();
    await this.build(opts.track);
  }

  async destroy(): Promise<void> {
    this.teardown();
  }

  private async build(track: MediaStreamTrack) {
    const [{ RnnoiseWorkletNode }, binary] = await Promise.all([
      import("@sapphi-red/web-noise-suppressor"),
      loadWasm(),
    ]);
    let ctx: AudioContext;
    try {
      ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: "interactive" });
    } catch {
      throw new Error("O navegador não cria o áudio a 48 kHz.");
    }
    this.ctx = ctx;
    if (ctx.sampleRate !== SAMPLE_RATE) throw new Error("O navegador não cria o áudio a 48 kHz.");
    if (ctx.state === "suspended") await ctx.resume().catch(() => {});
    await ctx.audioWorklet.addModule(rnnoiseWorkletUrl);
    const node = new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary: binary });
    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    const dest = ctx.createMediaStreamDestination();
    source.connect(node);
    node.connect(dest);
    this.node = node;
    this.source = source;
    this.dest = dest;
    this.processedTrack = dest.stream.getAudioTracks()[0];
    const monitor = new LoadMonitor(
      {
        wall: () => performance.now() / 1000,
        ctx: () => ctx.currentTime,
        running: () => ctx.state === "running",
      },
      { onLoad: (l) => this.hooks.onLoad?.(l), onSlow: () => this.hooks.onSlow?.() },
    );
    this.timer = setInterval(() => monitor.tick(), 2000);
  }

  private teardown() {
    clearInterval(this.timer);
    this.timer = undefined;
    try {
      this.source?.disconnect();
      this.node?.disconnect();
      this.node?.destroy();
    } catch {
      // grafo já desfeito
    }
    this.processedTrack?.stop();
    this.processedTrack = undefined;
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.node = this.source = this.dest = null;
  }
}
