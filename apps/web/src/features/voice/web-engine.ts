// Engine web: livekit-client (WebRTC do navegador). Único arquivo que conhece a lib (ver engine.ts).
import {
  type AudioCaptureOptions,
  type AudioProcessorOptions,
  ConnectionError,
  ConnectionQuality,
  ConnectionState as LkConnectionState,
  DisconnectReason as LkDisconnectReason,
  type LocalAudioTrack,
  type LocalTrackPublication,
  type Participant,
  type RemoteTrack,
  type RemoteTrackPublication,
  Room,
  RoomEvent,
  type ScreenShareCaptureOptions,
  Track,
  type TrackProcessor,
  type VideoTrack,
} from "livekit-client";
import { DEFAULT_AUDIO_PROCESSING } from "./devices";
import {
  type AudioCapabilities,
  type AudioProcessingOptions,
  type AudioProcessingStatus,
  type ConnectionState,
  type ConnectParams,
  type DeviceInfo,
  type DeviceKind,
  type DisconnectReason,
  Emitter,
  type LinkQuality,
  type LocalMedia,
  type NoiseSuppressionLevel,
  type VideoKind,
  type VideoSource,
  VoiceConnectError,
  type VoiceEngine,
  type VoiceEngineEvents,
  VoiceMediaError,
} from "./engine";

/** `<video>` + `track.attach`: a implementação web de `VideoSource`. */
function videoSourceOf(track: VideoTrack, muted: boolean): VideoSource {
  return {
    attach(host) {
      const video = document.createElement("video");
      video.autoplay = true;
      video.playsInline = true;
      video.muted = muted; // o áudio vai por outro elemento; a prévia local nunca toca
      video.className = "size-full object-contain";
      host.appendChild(video);
      track.attach(video);
      let done = false;
      return () => {
        if (done) return;
        done = true;
        track.detach(video);
        video.remove();
      };
    },
  };
}

const kindOf = (source: Track.Source): VideoKind | null =>
  source === Track.Source.Camera ? "camera" : source === Track.Source.ScreenShare ? "screen" : null;

function mapQuality(q: ConnectionQuality): LinkQuality {
  switch (q) {
    case ConnectionQuality.Excellent:
      return "excellent";
    case ConnectionQuality.Good:
      return "good";
    case ConnectionQuality.Poor:
      return "poor";
    case ConnectionQuality.Lost:
      return "lost";
    default:
      return "unknown";
  }
}

export function mapDisconnectReason(reason: LkDisconnectReason | undefined): DisconnectReason {
  switch (reason) {
    case LkDisconnectReason.CLIENT_INITIATED:
      return "client";
    case LkDisconnectReason.PARTICIPANT_REMOVED:
    case LkDisconnectReason.ROOM_DELETED:
    case LkDisconnectReason.ROOM_CLOSED:
    case LkDisconnectReason.DUPLICATE_IDENTITY:
      return "removed";
    case LkDisconnectReason.SERVER_SHUTDOWN:
    case LkDisconnectReason.SIGNAL_CLOSE:
    case LkDisconnectReason.CONNECTION_TIMEOUT:
    case LkDisconnectReason.JOIN_FAILURE:
    case LkDisconnectReason.MEDIA_FAILURE:
    case LkDisconnectReason.STATE_MISMATCH:
    case LkDisconnectReason.MIGRATION:
      return "network";
    default:
      return "unknown";
  }
}

function mapState(s: LkConnectionState): ConnectionState {
  switch (s) {
    case LkConnectionState.Connected:
      return "connected";
    case LkConnectionState.Connecting:
      return "connecting";
    case LkConnectionState.Reconnecting:
    case LkConnectionState.SignalReconnecting:
      return "reconnecting";
    default:
      return "disconnected";
  }
}

/** Traduz o erro do navegador/lib ao código que a interface usa. */
export function toMediaError(err: unknown, device: "microphone" | "camera" | "screen") {
  if (err instanceof VoiceMediaError) return err;
  const name = err instanceof Error ? err.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      // No getDisplayMedia, NotAllowedError é "o usuário cancelou o seletor" (ou negou).
      return new VoiceMediaError(device === "screen" ? "cancelled" : "permission-denied", device);
    case "NotFoundError":
    case "OverconstrainedError":
    case "DevicesNotFoundError":
      return new VoiceMediaError("not-found", device);
    case "NotReadableError":
    case "TrackStartError":
      return new VoiceMediaError("in-use", device);
    case "TypeError":
      return new VoiceMediaError("unsupported", device);
    default:
      return new VoiceMediaError("unknown", device, err instanceof Error ? err.message : undefined);
  }
}

/** O navegador tem o que o nível "Forte" (IA) precisa: AudioWorklet, WASM e MediaStreamDestination. */
export function supportsStrongNoiseSuppression(): boolean {
  try {
    return (
      typeof AudioContext !== "undefined" &&
      typeof AudioWorkletNode !== "undefined" &&
      typeof MediaStreamAudioDestinationNode !== "undefined" &&
      typeof WebAssembly === "object"
    );
  } catch {
    return false;
  }
}

/**
 * Constraints do microfone para o nível de ruído EM EFEITO. No "Forte" o filtro do navegador fica desligado
 * (a IA já limpa o sinal; processar duas vezes distorce a voz). `voiceIsolation` (isolamento de voz, mais forte
 * que `noiseSuppression`) só entra no "Padrão" e é best-effort: navegador que não conhece a constraint a ignora.
 */
export function micConstraints(
  o: AudioProcessingOptions,
  level: NoiseSuppressionLevel,
): AudioCaptureOptions {
  return {
    echoCancellation: o.echoCancellation,
    autoGainControl: o.autoGainControl,
    noiseSuppression: level === "standard",
    voiceIsolation: level === "standard",
  };
}

/**
 * Opções do `getDisplayMedia` (Chrome) pensadas para não gerar eco:
 * - `selfBrowserSurface: "exclude"`: não oferece a própria aba do Spook (realimentaria a chamada);
 * - `suppressLocalAudioPlayback`: o áudio capturado deixa de tocar nas caixas locais (a lib não repassa a opção
 *   do nível superior, por isso ela vai também dentro de `audio`);
 * - `restrictOwnAudio`: tira do áudio capturado o som que a própria aba (a chamada) toca;
 * - `systemAudio` só é oferecido quando o usuário pediu áudio.
 * Navegadores que não conhecem uma opção a ignoram.
 */
export function screenShareOptions(audio: boolean): ScreenShareCaptureOptions {
  return {
    audio: audio
      ? ({
          echoCancellation: true,
          noiseSuppression: false,
          autoGainControl: false,
          suppressLocalAudioPlayback: true,
          restrictOwnAudio: true,
        } as AudioCaptureOptions)
      : false,
    selfBrowserSurface: "exclude",
    systemAudio: audio ? "include" : "exclude",
    suppressLocalAudioPlayback: true,
  };
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export class WebVoiceEngine extends Emitter<VoiceEngineEvents> implements VoiceEngine {
  private room: Room | null = null;
  private deafened = false;
  private audioEls = new Map<string, HTMLMediaElement>();
  private audioHost: HTMLElement | null = null;
  /** Evita emitir `disconnected` duas vezes (por `disconnect()` e pelo evento da lib). */
  private closing = false;
  /** Eco/ruído/ganho pedidos; `level` é o nível de ruído EM EFEITO (pode estar rebaixado para "standard"). */
  private audio: AudioProcessingOptions = { ...DEFAULT_AUDIO_PROCESSING };
  private level: NoiseSuppressionLevel = DEFAULT_AUDIO_PROCESSING.noiseSuppression;
  /** Serializa as reaplicações do microfone (troca de nível, rebaixamento) para não se atropelarem. */
  private micQueue: Promise<void> = Promise.resolve();
  readonly audioCapabilities: AudioCapabilities = supportsStrongNoiseSuppression()
    ? { strongNoiseSuppression: true }
    : { strongNoiseSuppression: false, strongUnavailableReason: "indisponível neste navegador" };

  get state(): ConnectionState {
    return this.room ? mapState(this.room.state) : "disconnected";
  }

  async connect({ url, token }: ConnectParams): Promise<void> {
    await this.disconnect();
    const room = new Room({ adaptiveStream: true, dynacast: true });
    this.room = room;
    this.closing = false;
    this.wire(room);
    try {
      await room.connect(url, token, { autoSubscribe: true });
    } catch (err) {
      this.teardown(room);
      throw toConnectError(err);
    }
    // Quem já estava na sala.
    for (const p of room.remoteParticipants.values())
      this.emit("participant-joined", { identity: p.identity });
  }

  async disconnect(): Promise<void> {
    const room = this.room;
    if (!room) return;
    this.closing = true;
    this.teardown(room);
    this.emit("disconnected", { reason: "client" });
  }

  /** Solta a sala e os elementos de áudio sem emitir nada. */
  private teardown(room: Room) {
    if (this.room === room) this.room = null;
    room.removeAllListeners();
    void room.disconnect().catch(() => {});
    for (const el of this.audioEls.values()) el.remove();
    this.audioEls.clear();
  }

  private wire(room: Room) {
    room
      .on(RoomEvent.ParticipantConnected, (p) =>
        this.emit("participant-joined", { identity: p.identity }),
      )
      .on(RoomEvent.ParticipantDisconnected, (p) =>
        this.emit("participant-left", { identity: p.identity }),
      )
      .on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) =>
        this.emit("speakers-changed", { identities: speakers.map((s) => s.identity) }),
      )
      .on(RoomEvent.TrackSubscribed, (track, pub, participant) =>
        this.onSubscribed(track, pub, participant.identity),
      )
      .on(RoomEvent.TrackUnsubscribed, (track, pub) => this.onUnsubscribed(track, pub))
      .on(RoomEvent.LocalTrackPublished, (pub, participant) => {
        this.onLocalPublished(pub, participant.identity);
        this.emitLocalMedia();
      })
      .on(RoomEvent.LocalTrackUnpublished, (pub) => {
        if (pub.trackSid && kindOf(pub.source))
          this.emit("video-track-removed", { id: pub.trackSid });
        this.emitLocalMedia();
      })
      .on(RoomEvent.TrackMuted, () => this.emitLocalMedia())
      .on(RoomEvent.TrackUnmuted, () => this.emitLocalMedia())
      .on(RoomEvent.Reconnecting, () => this.emit("connection-state", { state: "reconnecting" }))
      .on(RoomEvent.Reconnected, () => this.emit("connection-state", { state: "connected" }))
      .on(RoomEvent.ConnectionQualityChanged, (q, participant) => {
        if (participant.isLocal) this.emit("link-quality", { quality: mapQuality(q) });
      })
      .on(RoomEvent.AudioPlaybackStatusChanged, () =>
        this.emit("audio-blocked", { blocked: !room.canPlaybackAudio }),
      )
      .on(RoomEvent.MediaDevicesChanged, () => this.emit("devices-changed", {}))
      .on(RoomEvent.Disconnected, (reason) => {
        if (this.closing || this.room !== room) return;
        this.teardown(room);
        this.emit("disconnected", { reason: mapDisconnectReason(reason) });
      });
  }

  private onSubscribed(track: RemoteTrack, pub: RemoteTrackPublication, identity: string) {
    if (track.kind === Track.Kind.Audio) {
      const el = track.attach();
      el.muted = this.deafened;
      this.audioHost = this.audioHost ?? audioHostElement();
      this.audioHost.appendChild(el);
      this.audioEls.set(pub.trackSid, el);
      return;
    }
    const kind = kindOf(pub.source);
    if (!kind) return;
    this.emit("video-track-added", {
      id: pub.trackSid,
      identity,
      kind,
      local: false,
      source: videoSourceOf(track as VideoTrack, true),
    });
  }

  private onUnsubscribed(track: RemoteTrack, pub: RemoteTrackPublication) {
    if (track.kind === Track.Kind.Audio) {
      track.detach();
      this.audioEls.get(pub.trackSid)?.remove();
      this.audioEls.delete(pub.trackSid);
      return;
    }
    this.emit("video-track-removed", { id: pub.trackSid });
  }

  private onLocalPublished(pub: LocalTrackPublication, identity: string) {
    const track = pub.track;
    const kind = kindOf(pub.source);
    if (!track || !kind || track.kind !== Track.Kind.Video) return;
    this.emit("video-track-added", {
      id: pub.trackSid,
      identity,
      kind,
      local: true,
      source: videoSourceOf(track as VideoTrack, true),
    });
  }

  private localMedia(): LocalMedia {
    const lp = this.room?.localParticipant;
    return {
      microphone: !!lp?.isMicrophoneEnabled,
      camera: !!lp?.isCameraEnabled,
      screenShare: !!lp?.isScreenShareEnabled,
    };
  }

  private emitLocalMedia() {
    this.emit("local-media", this.localMedia());
  }

  private requireRoom(): Room {
    if (!this.room) throw new VoiceConnectError("unknown", "sem sala de voz ativa");
    return this.room;
  }

  async setMicrophoneEnabled(enabled: boolean) {
    const lp = this.requireRoom().localParticipant;
    try {
      const pub = await lp.setMicrophoneEnabled(
        enabled,
        enabled ? micConstraints(this.audio, this.level) : undefined,
      );
      if (enabled) await this.syncProcessor(pub?.audioTrack as LocalAudioTrack | undefined);
    } catch (err) {
      throw toMediaError(err, "microphone");
    }
  }

  async setAudioProcessing(options: AudioProcessingOptions): Promise<void> {
    const prev = this.audio;
    const wantsStrong = options.noiseSuppression === "strong";
    const unsupported = wantsStrong && !this.audioCapabilities.strongNoiseSuppression;
    this.audio = unsupported ? { ...options, noiseSuppression: "standard" } : { ...options };
    this.level = this.audio.noiseSuppression;
    if (unsupported)
      this.setStatus({
        level: "standard",
        state: "degraded",
        reason: "Este navegador não suporta a redução de ruído por IA. Usando o filtro Padrão.",
      });
    else this.setStatus({ level: this.level, state: "idle" });
    const same =
      prev.echoCancellation === this.audio.echoCancellation &&
      prev.autoGainControl === this.audio.autoGainControl &&
      prev.noiseSuppression === this.audio.noiseSuppression;
    if (same) return;
    await this.enqueueMic(() => this.reapplyMic());
  }

  private enqueueMic(job: () => Promise<void>): Promise<void> {
    const run = this.micQueue.then(job, job);
    this.micQueue = run.catch(() => {});
    return run;
  }

  private setStatus(status: AudioProcessingStatus) {
    this.emit("audio-processing-status", status);
  }

  /** O microfone ativo foi capturado com outras opções: recaptura (ligado) ou descarta o track (mudo). */
  private async reapplyMic() {
    const lp = this.room?.localParticipant;
    const pub = lp?.getTrackPublication(Track.Source.Microphone);
    const track = pub?.audioTrack as LocalAudioTrack | undefined;
    if (!lp || !pub || !track) return;
    try {
      if (pub.isMuted) {
        // Mudo não tem captura em andamento: descarta o track para a próxima ativação capturar já com as
        // opções novas (o mudo continua valendo: quem liga o microfone é o controlador).
        await lp.unpublishTrack(track, true);
        return;
      }
      if (this.level !== "strong" && track.getProcessor()) await track.stopProcessor();
      await track.restartTrack(micConstraints(this.audio, this.level));
      await this.syncProcessor(track);
    } catch (err) {
      await this.degrade(this.reasonOf(err));
    }
  }

  /** Coloca ou tira o processador de IA do track conforme o nível em efeito. */
  private async syncProcessor(track: LocalAudioTrack | undefined) {
    if (!track) return;
    if (this.level !== "strong") {
      if (track.getProcessor()) await track.stopProcessor();
      return;
    }
    if (track.getProcessor()) return;
    this.setStatus({ level: "strong", state: "loading" });
    try {
      const { RnnoiseTrackProcessor, LOAD_TIMEOUT_MS } = await import("./noise-processor");
      const processor = new RnnoiseTrackProcessor({
        onLoad: (load) => this.setStatus({ level: "strong", state: "active", load }),
        onSlow: () =>
          void this.enqueueMic(() =>
            this.degrade("O processamento por IA ficou lento demais neste computador."),
          ),
      });
      await withTimeout(
        track.setProcessor(
          processor as unknown as TrackProcessor<Track.Kind.Audio, AudioProcessorOptions>,
        ),
        LOAD_TIMEOUT_MS,
        "tempo esgotado ao carregar o modelo de IA",
      );
      this.setStatus({ level: "strong", state: "active", load: "ok" });
    } catch (err) {
      await this.degrade(this.reasonOf(err));
    }
  }

  private reasonOf(err: unknown): string {
    const detail = err instanceof Error && err.message ? ` (${err.message})` : "";
    return `Não foi possível iniciar a redução de ruído por IA${detail}. Usando o filtro Padrão.`;
  }

  /** A IA não rodou (ou ficou lenta): volta para "Padrão" sem mexer na chamada e avisa. */
  private async degrade(reason: string) {
    if (this.level !== "strong") return;
    this.level = "standard";
    this.audio = { ...this.audio, noiseSuppression: "standard" };
    this.setStatus({ level: "standard", state: "degraded", reason });
    const lp = this.room?.localParticipant;
    const track = lp?.getTrackPublication(Track.Source.Microphone)?.audioTrack as
      | LocalAudioTrack
      | undefined;
    if (!track) return;
    try {
      await track.stopProcessor().catch(() => {});
      if (!lp?.getTrackPublication(Track.Source.Microphone)?.isMuted)
        await track.restartTrack(micConstraints(this.audio, "standard"));
    } catch (err) {
      console.warn("voz: falha ao voltar ao filtro Padrão", err);
    }
  }

  async setCameraEnabled(enabled: boolean) {
    const lp = this.requireRoom().localParticipant;
    try {
      await lp.setCameraEnabled(enabled);
    } catch (err) {
      throw toMediaError(err, "camera");
    }
  }

  async setScreenShareEnabled(enabled: boolean, opts: { audio?: boolean } = {}) {
    const lp = this.requireRoom().localParticipant;
    try {
      await lp.setScreenShareEnabled(
        enabled,
        enabled ? screenShareOptions(!!opts.audio) : undefined,
      );
    } catch (err) {
      throw toMediaError(err, "screen");
    }
  }

  setDeafened(deafened: boolean) {
    this.deafened = deafened;
    for (const el of this.audioEls.values()) el.muted = deafened;
  }

  async resumeAudio() {
    await this.room?.startAudio();
  }

  async listDevices(kind: DeviceKind): Promise<DeviceInfo[]> {
    try {
      const list = await Room.getLocalDevices(kind, false);
      return list.map((d) => ({ id: d.deviceId, label: d.label || "Dispositivo sem nome" }));
    } catch {
      return [];
    }
  }

  async setDevice(kind: DeviceKind, deviceId: string) {
    const room = this.room;
    if (!room) return; // sem sala: quem chama já persistiu; vale na próxima captura
    await room.switchActiveDevice(kind, deviceId);
  }
}

function audioHostElement(): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("data-voice-audio", "");
  el.hidden = true;
  document.body.appendChild(el);
  return el;
}

function toConnectError(err: unknown): VoiceConnectError {
  if (err instanceof ConnectionError) {
    // 401/403 do endpoint de validação do LiveKit: token vencido ou inválido.
    if (err.status === 401 || err.status === 403)
      return new VoiceConnectError("token-rejected", err.message);
    return new VoiceConnectError("unreachable", err.message);
  }
  return new VoiceConnectError("unknown", err instanceof Error ? err.message : undefined);
}

/** Cria a engine web (livekit-client). */
export function createWebVoiceEngine(): VoiceEngine {
  return new WebVoiceEngine();
}
