// Captura de TESTE do microfone (web): medidor de nível fora da chamada (ou com o microfone mudo) e o "Testar"
// (grava ~5 s e toca de volta). Passa pelo MESMO processamento da chamada (constraints do navegador, RNNoise e
// porta de ruído, via `MicTrackProcessor`). Não importa `livekit-client`. Nunca reproduz o microfone ao vivo.
import { t } from "@/i18n";
import type { InputLevel, InputSensitivity, MediaErrorCode, MicTestState } from "./engine";
import type { MicTrackProcessor } from "./noise-processor";

export const MIC_TEST_DURATION_MS = 5000;

export type PipelineOptions = {
  constraints: MediaTrackConstraints;
  /** Microfone escolhido (ausente = padrão do sistema). */
  deviceId?: string;
  strong: boolean;
  sensitivity: InputSensitivity;
  onLevel: (l: InputLevel) => void;
  /** O RNNoise não acompanhou o tempo real nem carregou: o chamador decide o que fazer (recomeçar sem IA). */
  onFail?: (reason: string) => void;
};

/** getUserMedia -> processador -> faixa processada. Uma instância por captura de teste. */
export class MicPipeline {
  private stream: MediaStream | null = null;
  private processor: MicTrackProcessor | null = null;
  private stopped = false;

  constructor(private readonly opts: PipelineOptions) {}

  /** Abre o microfone e monta o grafo. Devolve a faixa JÁ processada. Rejeita com o erro do navegador. */
  async start(): Promise<MediaStreamTrack> {
    const constraints: MediaTrackConstraints = { ...this.opts.constraints };
    if (this.opts.deviceId) constraints.deviceId = { exact: this.opts.deviceId };
    const stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
    if (this.stopped) {
      for (const t of stream.getTracks()) t.stop();
      throw new Error("captura cancelada");
    }
    this.stream = stream;
    const input = stream.getAudioTracks()[0];
    if (!input) throw new Error("sem faixa de áudio");
    try {
      const { MicTrackProcessor } = await import("./noise-processor");
      const processor = new MicTrackProcessor({
        strong: this.opts.strong,
        sensitivity: this.opts.sensitivity,
        onLevel: this.opts.onLevel,
        onSlow: () => this.opts.onFail?.(t("voice.engine.aiSlow")),
      });
      this.processor = processor;
      await processor.init({ track: input });
      if (this.stopped) {
        this.stop();
        throw new Error("captura cancelada");
      }
      if (!processor.processedTrack) throw new Error("sem faixa processada");
      return processor.processedTrack;
    } catch (err) {
      this.stop();
      throw err;
    }
  }

  configure(sensitivity: InputSensitivity) {
    this.processor?.configure(sensitivity);
  }

  stop() {
    this.stopped = true;
    void this.processor?.destroy();
    this.processor = null;
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.stream = null;
  }
}

type SinkAudio = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };

export type MicTestDeps = {
  createPipeline: (o: PipelineOptions) => MicPipeline;
  createRecorder: (stream: MediaStream) => MediaRecorder;
  createAudio: (url: string) => SinkAudio;
  createObjectUrl: (b: Blob) => string;
  revokeObjectUrl: (u: string) => void;
};

const mimeForRecorder = () => {
  if (typeof MediaRecorder === "undefined") return undefined;
  for (const m of ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"])
    if (MediaRecorder.isTypeSupported?.(m)) return m;
  return undefined;
};

export const defaultMicTestDeps: MicTestDeps = {
  createPipeline: (o) => new MicPipeline(o),
  createRecorder: (stream) => {
    const mimeType = mimeForRecorder();
    return new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  },
  createAudio: (url) => new Audio(url),
  createObjectUrl: (b) => URL.createObjectURL(b),
  revokeObjectUrl: (u) => URL.revokeObjectURL(u),
};

function codeOf(err: unknown): MediaErrorCode {
  const name = err instanceof Error ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "permission-denied";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "not-found";
  if (name === "NotReadableError") return "in-use";
  return "unknown";
}

/** Grava `durationMs` do microfone processado e reproduz no alto-falante escolhido. Um teste por vez. */
export class MicTester {
  private cancelled = false;
  private cleanup: (() => void) | null = null;
  running = false;

  constructor(private readonly deps: MicTestDeps = defaultMicTestDeps) {}

  cancel() {
    this.cancelled = true;
    this.cleanup?.();
  }

  async run(
    opts: PipelineOptions & { outputDeviceId?: string; durationMs?: number },
    emit: (s: MicTestState) => void,
  ): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.cancelled = false;
    const durationMs = opts.durationMs ?? MIC_TEST_DURATION_MS;
    const timers = new Set<ReturnType<typeof setInterval>>();
    let pipeline: MicPipeline | null = null;
    let audio: SinkAudio | null = null;
    let url: string | null = null;
    let finish: (() => void) | null = null;
    this.cleanup = () => {
      for (const t of timers) clearInterval(t);
      timers.clear();
      pipeline?.stop();
      audio?.pause();
      finish?.();
    };
    try {
      emit({ phase: "requesting" });
      pipeline = this.deps.createPipeline(opts);
      const track = await pipeline.start();
      if (this.cancelled) return;

      // ---- gravando ----
      const chunks: Blob[] = [];
      const recorder = this.deps.createRecorder(new MediaStream([track]));
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      const stopped = new Promise<void>((resolve) => {
        recorder.onstop = () => resolve();
      });
      recorder.start();
      const startedAt = Date.now();
      emit({ phase: "recording", remainingMs: durationMs });
      await new Promise<void>((resolve) => {
        finish = resolve;
        const t = setInterval(() => {
          const left = durationMs - (Date.now() - startedAt);
          if (left <= 0) {
            clearInterval(t);
            timers.delete(t);
            resolve();
          } else emit({ phase: "recording", remainingMs: left });
        }, 100);
        timers.add(t);
      });
      finish = null;
      if (recorder.state !== "inactive") recorder.stop();
      if (!this.cancelled) await stopped;
      pipeline.stop();
      if (this.cancelled) return;

      // ---- reproduzindo (no alto-falante escolhido; nunca ao vivo) ----
      url = this.deps.createObjectUrl(
        new Blob(chunks, { type: recorder.mimeType || "audio/webm" }),
      );
      audio = this.deps.createAudio(url);
      if (opts.outputDeviceId && audio.setSinkId)
        await audio.setSinkId(opts.outputDeviceId).catch(() => {});
      await audio.play();
      emit({ phase: "playing", remainingMs: durationMs });
      const playing = audio;
      await new Promise<void>((resolve) => {
        finish = resolve;
        playing.onended = () => resolve();
        playing.onerror = () => resolve();
        const t = setInterval(() => {
          const total = Number.isFinite(playing.duration) ? playing.duration : durationMs / 1000;
          emit({
            phase: "playing",
            remainingMs: Math.max(0, Math.round((total - playing.currentTime) * 1000)),
          });
        }, 100);
        timers.add(t);
      });
      if (!this.cancelled) emit({ phase: "done" });
    } catch (err) {
      if (!this.cancelled) emit({ phase: "error", error: codeOf(err) });
    } finally {
      this.cleanup?.();
      this.cleanup = null;
      if (url) this.deps.revokeObjectUrl(url);
      if (this.cancelled) emit({ phase: "done" });
      this.running = false;
    }
  }
}
