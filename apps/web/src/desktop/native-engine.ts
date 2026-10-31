// Engine de voz NATIVA do desktop (RF12.2): implementa `VoiceEngine` falando com o núcleo Rust
// (LiveKit Rust SDK + cpal + scap + nokhwa) por comandos e canais do Tauri. O WebView NUNCA usa
// `getUserMedia`, `getDisplayMedia` nem `RTCPeerConnection`: o áudio é capturado/tocado no Rust, e o vídeo
// remoto chega como JPEG que desenhamos num `<canvas>`.
import {
  type ConnectionState,
  type ConnectParams,
  type DeviceInfo,
  type DeviceKind,
  type DisconnectReason,
  Emitter,
  type LinkQuality,
  type LocalMedia,
  type VideoKind,
  type VideoSource,
  VoiceConnectError,
  type VoiceEngine,
  type VoiceEngineEvents,
  VoiceMediaError,
} from "@/features/voice/engine";
import { decodeFrame } from "./frame-wire";
import { createChannel, invoke } from "./ipc";
import { toConnectError, toMediaError } from "./native-errors";
import { pickScreenSource, type ScreenSource } from "./screen-picker";

/** Eventos que o Rust envia pelo canal da sala (`src-tauri/src/voice/events.rs`). */
export type NativeEvent =
  | { type: "participant-joined"; identity: string }
  | { type: "participant-left"; identity: string }
  | { type: "speakers-changed"; identities: string[] }
  | { type: "video-track-added"; id: string; identity: string; kind: VideoKind; local: boolean }
  | { type: "video-track-removed"; id: string }
  | { type: "connection-state"; state: ConnectionState }
  | { type: "link-quality"; quality: LinkQuality }
  | ({ type: "local-media" } & LocalMedia)
  | { type: "devices-changed" }
  | { type: "disconnected"; reason: DisconnectReason };

export type NativeDeps = {
  invoke: typeof invoke;
  createChannel: typeof createChannel;
  pickScreenSource: typeof pickScreenSource;
};

const defaultDeps = (): NativeDeps => ({ invoke, createChannel, pickScreenSource });

/**
 * Uma faixa de vídeo: uma única inscrição no Rust, desenhada em quantos `<canvas>` estiverem montados.
 * Quando o último é desmontado, o Rust para de converter e enviar (ninguém está desenhando).
 */
export class TrackView {
  private canvases = new Set<HTMLCanvasElement>();
  private subscribed = false;
  /** Invalida inscrições em andamento quando a faixa é desmontada. */
  private epoch = 0;
  private drawing = false;
  /** O quadro mais novo recebido enquanto o anterior ainda era desenhado (os mais velhos são descartados). */
  private pending: ReturnType<typeof decodeFrame> = null;
  private hasPending = false;
  private disposed = false;

  constructor(
    private readonly deps: NativeDeps,
    readonly trackId: string,
    private readonly maxSize?: { maxWidth?: number; maxHeight?: number; fps?: number },
  ) {}

  readonly source: VideoSource = { attach: (host) => this.attach(host) };

  private attach(host: HTMLElement): () => void {
    const canvas = document.createElement("canvas");
    canvas.className = "size-full object-contain";
    host.appendChild(canvas);
    this.canvases.add(canvas);
    if (!this.subscribed && !this.disposed) void this.subscribe();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      canvas.remove();
      this.canvases.delete(canvas);
      if (this.canvases.size === 0) void this.unsubscribe();
    };
  }

  private async subscribe() {
    this.subscribed = true;
    const epoch = ++this.epoch;
    try {
      const channel = await this.deps.createChannel<unknown>((data) => {
        if (epoch === this.epoch) this.onMessage(data);
      });
      if (epoch !== this.epoch) return;
      await this.deps.invoke("voice_video_subscribe", {
        trackId: this.trackId,
        frames: channel,
        options: this.maxSize,
      });
    } catch {
      if (epoch === this.epoch) this.subscribed = false;
    }
  }

  private async unsubscribe() {
    if (!this.subscribed) return;
    this.subscribed = false;
    this.epoch++;
    this.pending = null;
    this.hasPending = false;
    await this.deps.invoke("voice_video_unsubscribe", { trackId: this.trackId }).catch(() => {});
  }

  /** A faixa saiu (ou a sala acabou): para tudo. Os canvases ficam com o último quadro até o React desmontar. */
  dispose() {
    this.disposed = true;
    void this.unsubscribe();
  }

  private ack() {
    void this.deps.invoke("voice_video_ack", { trackId: this.trackId }).catch(() => {});
  }

  private onMessage(data: unknown) {
    const frame = decodeFrame(data);
    if (!frame) {
      this.ack();
      return;
    }
    if (this.drawing) {
      // Ainda desenhando o anterior: guarda só o mais novo e devolve o crédito do que ficou para trás.
      if (this.hasPending) this.ack();
      this.pending = frame;
      this.hasPending = true;
      return;
    }
    void this.draw(frame);
  }

  private async draw(frame: NonNullable<ReturnType<typeof decodeFrame>>) {
    this.drawing = true;
    try {
      const bitmap = await createImageBitmap(
        new Blob([frame.jpeg as BlobPart], { type: "image/jpeg" }),
      );
      try {
        for (const canvas of this.canvases) {
          if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
          if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
          canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
        }
      } finally {
        bitmap.close();
      }
    } catch {
      // JPEG corrompido: ignora o quadro.
    } finally {
      this.ack();
      this.drawing = false;
      const next = this.pending;
      const had = this.hasPending;
      this.pending = null;
      this.hasPending = false;
      if (had) {
        if (next && this.canvases.size > 0 && !this.disposed) void this.draw(next);
        else this.ack();
      }
    }
  }
}

export class NativeVoiceEngine extends Emitter<VoiceEngineEvents> implements VoiceEngine {
  state: ConnectionState = "disconnected";
  private active = false;
  /** Cada conexão tem um número; eventos de canais antigos são ignorados. */
  private generation = 0;
  private views = new Map<string, TrackView>();

  constructor(private readonly deps: NativeDeps = defaultDeps()) {
    super();
  }

  async connect({ url, token }: ConnectParams): Promise<void> {
    await this.disconnect();
    const generation = ++this.generation;
    this.state = "connecting";
    this.active = true;
    try {
      const channel = await this.deps.createChannel<NativeEvent>((e) => {
        if (generation === this.generation) this.onEvent(e);
      });
      await this.deps.invoke("voice_connect", { url, token, events: channel });
    } catch (err) {
      if (generation === this.generation) {
        this.active = false;
        this.state = "disconnected";
        this.disposeViews();
      }
      throw toConnectError(err);
    }
    if (generation === this.generation) this.state = "connected";
  }

  async disconnect(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    this.generation++; // ignora o que ainda chegar do canal antigo
    this.state = "disconnected";
    this.disposeViews();
    try {
      await this.deps.invoke("voice_disconnect");
    } catch {
      // já desconectado
    }
    this.emit("disconnected", { reason: "client" });
  }

  private requireRoom() {
    if (!this.active) throw new VoiceConnectError("unknown", "sem sala de voz ativa");
  }

  async setMicrophoneEnabled(enabled: boolean) {
    this.requireRoom();
    try {
      await this.deps.invoke("voice_set_microphone", { enabled });
    } catch (err) {
      throw toMediaError(err, "microphone");
    }
  }

  async setCameraEnabled(enabled: boolean) {
    this.requireRoom();
    try {
      await this.deps.invoke("voice_set_camera_enabled", { on: enabled });
    } catch (err) {
      throw toMediaError(err, "camera");
    }
  }

  async setScreenShareEnabled(enabled: boolean, opts: { audio?: boolean } = {}) {
    this.requireRoom();
    try {
      if (!enabled) {
        await this.deps.invoke("voice_set_screen_share", { on: false });
        return;
      }
      const sources = await this.deps.invoke<ScreenSource[]>("voice_list_screen_sources");
      const sourceId = await this.deps.pickScreenSource(sources);
      if (!sourceId) throw new VoiceMediaError("cancelled", "screen");
      // O áudio do sistema ainda não é capturado no desktop (limitação documentada); o Rust ignora o pedido.
      await this.deps.invoke("voice_set_screen_share", {
        on: true,
        options: { sourceId, audio: !!opts.audio },
      });
    } catch (err) {
      throw toMediaError(err, "screen");
    }
  }

  setDeafened(deafened: boolean) {
    void this.deps.invoke("voice_set_deafened", { deafened }).catch(() => {});
  }

  /** O áudio é tocado pelo Rust: nunca há bloqueio de reprodução automática como no navegador. */
  async resumeAudio() {}

  async listDevices(kind: DeviceKind): Promise<DeviceInfo[]> {
    try {
      const list = await this.deps.invoke<DeviceInfo[]>("voice_list_devices", { kind });
      return list.map((d) => ({ id: d.id, label: d.label || "Dispositivo sem nome" }));
    } catch {
      return [];
    }
  }

  async setDevice(kind: DeviceKind, deviceId: string) {
    try {
      await this.deps.invoke("voice_set_device", {
        kind,
        id: deviceId === "default" ? "" : deviceId,
      });
    } catch (err) {
      throw toMediaError(err, kind === "videoinput" ? "camera" : "microphone");
    }
  }

  private disposeViews() {
    for (const v of this.views.values()) v.dispose();
    this.views.clear();
  }

  private onEvent(e: NativeEvent) {
    switch (e.type) {
      case "participant-joined":
        this.emit("participant-joined", { identity: e.identity });
        break;
      case "participant-left":
        this.emit("participant-left", { identity: e.identity });
        break;
      case "speakers-changed":
        this.emit("speakers-changed", { identities: e.identities });
        break;
      case "video-track-added": {
        const view = new TrackView(
          this.deps,
          e.id,
          e.local ? { maxWidth: 640, maxHeight: 360 } : undefined,
        );
        this.views.set(e.id, view);
        this.emit("video-track-added", {
          id: e.id,
          identity: e.identity,
          kind: e.kind,
          local: e.local,
          source: view.source,
        });
        break;
      }
      case "video-track-removed":
        this.views.get(e.id)?.dispose();
        this.views.delete(e.id);
        this.emit("video-track-removed", { id: e.id });
        break;
      case "connection-state":
        this.state = e.state;
        this.emit("connection-state", { state: e.state });
        break;
      case "link-quality":
        this.emit("link-quality", { quality: e.quality });
        break;
      case "local-media":
        this.emit("local-media", {
          microphone: e.microphone,
          camera: e.camera,
          screenShare: e.screenShare,
        });
        break;
      case "devices-changed":
        this.emit("devices-changed", {});
        break;
      case "disconnected":
        // O Rust já derrubou a sala (servidor, rede…): limpa e avisa. O nosso próprio `disconnect()` já invalidou a geração.
        this.active = false;
        this.state = "disconnected";
        this.disposeViews();
        this.emit("disconnected", { reason: e.reason });
        break;
    }
  }
}

/** Cria a engine nativa (registrada em `bootstrapDesktop` por `registerNativeVoiceEngine`). */
export function createNativeVoiceEngine(deps?: NativeDeps): VoiceEngine {
  return new NativeVoiceEngine(deps);
}
