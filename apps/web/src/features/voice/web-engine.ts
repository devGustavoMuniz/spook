// Engine web: livekit-client (WebRTC do navegador). Único arquivo que conhece a lib (ver engine.ts).
import {
  type AudioCaptureOptions,
  type AudioProcessorOptions,
  ConnectionError,
  ConnectionQuality,
  createLocalAudioTrack,
  ConnectionState as LkConnectionState,
  DisconnectReason as LkDisconnectReason,
  type LocalAudioTrack,
  type LocalTrackPublication,
  type LocalVideoTrack,
  type Participant,
  type RemoteAudioTrack,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteVideoTrack,
  Room,
  RoomEvent,
  type ScreenShareCaptureOptions,
  Track,
  type TrackProcessor,
  type TrackPublishOptions,
  VideoQuality,
  type VideoTrack,
} from "livekit-client";
import { t } from "@/i18n";
import { DEFAULT_AUDIO_PROCESSING, loadAudioProcessing, loadDevicePrefs } from "./devices";
import {
  type AudioCapabilities,
  type AudioProcessingOptions,
  type AudioProcessingStatus,
  type AudioSource,
  type ConnectionState,
  type ConnectionStats,
  type ConnectParams,
  type DeviceInfo,
  type DeviceKind,
  type DisconnectReason,
  Emitter,
  type FlowState,
  type InputLevel,
  type InputSensitivity,
  type LinkQuality,
  type LocalMedia,
  type NoiseSuppressionLevel,
  type ScreenShareQuality,
  type StreamStats,
  type VideoKind,
  type VideoSource,
  VoiceConnectError,
  type VoiceEngine,
  type VoiceEngineEvents,
  VoiceMediaError,
} from "./engine";
import { markJoin } from "./join-perf";
import { MIC_TEST_DURATION_MS, MicPipeline, MicTester, type PipelineOptions } from "./mic-test";
import type { MicTrackProcessor } from "./noise-processor";
import { estimateUplinkKbps } from "./screen-quality";

/** O navegador abre vídeo em janela flutuante (Picture-in-Picture)? */
export function supportsPictureInPicture(): boolean {
  try {
    return (
      typeof document !== "undefined" &&
      document.pictureInPictureEnabled === true &&
      typeof HTMLVideoElement !== "undefined" &&
      typeof HTMLVideoElement.prototype.requestPictureInPicture === "function"
    );
  } catch {
    return false;
  }
}

/** Web: o volume vai até 100% (ver SPEC 5.5: acima disso exigiria mixar pelo WebAudio e arriscaria o eco). */
export const WEB_MAX_PARTICIPANT_VOLUME = 1;

const sourceOfAudio = (s: AudioSource) =>
  s === "screen" ? Track.Source.ScreenShareAudio : Track.Source.Microphone;

/** Nome da camada simulcast a partir da largura recebida frente à largura publicada (`q` < `h` < `f`). */
export function layerOf(frameWidth: number | undefined, publishedWidth: number | undefined) {
  if (!frameWidth || !publishedWidth) return null;
  const r = frameWidth / publishedWidth;
  return r >= 0.9 ? "f" : r >= 0.45 ? "h" : "q";
}

type Sample = { at: number; bytes: number; frames: number };

/** bitrate (kbps) e fps entre duas amostras; `null` na primeira (não há com o que comparar). */
export function rates(prev: Sample | null, cur: Sample) {
  if (!prev || cur.at <= prev.at) return { kbps: null, fps: null };
  const dt = (cur.at - prev.at) / 1000;
  return {
    kbps: Math.max(0, Math.round(((cur.bytes - prev.bytes) * 8) / 1000 / dt)),
    fps: Math.max(0, Math.round((cur.frames - prev.frames) / dt)),
  };
}

function receiverStats(track: RemoteVideoTrack, pub?: RemoteTrackPublication) {
  let prev: Sample | null = null;
  return async (): Promise<StreamStats | null> => {
    const s = await track.getReceiverStats?.().catch(() => undefined);
    if (!s) return null;
    const cur = { at: s.timestamp, bytes: s.bytesReceived ?? 0, frames: s.framesDecoded };
    const r = rates(prev, cur);
    prev = cur;
    return {
      role: "receive",
      width: s.frameWidth ?? null,
      height: s.frameHeight ?? null,
      fps: r.fps,
      bitrateKbps: r.kbps,
      codec: s.mimeType?.replace(/^video\//i, "") ?? null,
      limitation: null,
      layer: pub?.simulcasted ? layerOf(s.frameWidth, pub.dimensions?.width) : "single",
      subscription:
        track.streamState === Track.StreamState.Paused
          ? "paused"
          : pub?.isSubscribed === false
            ? "unsubscribed"
            : "subscribed",
    };
  };
}

function senderStats(track: LocalVideoTrack, pub?: LocalTrackPublication) {
  let prev: Sample | null = null;
  return async (): Promise<StreamStats | null> => {
    const list = await track.getSenderStats?.().catch(() => undefined);
    if (!list || list.length === 0) return null;
    // A camada ativa mais alta (sem simulcast há uma só).
    const active = list.filter((l) => (l.framesPerSecond ?? 0) > 0);
    const top = [...(active.length ? active : list)].sort(
      (a, b) => (b.frameWidth ?? 0) - (a.frameWidth ?? 0),
    )[0];
    if (!top) return null;
    const cur = { at: top.timestamp, bytes: top.bytesSent ?? 0, frames: top.framesSent };
    const r = rates(prev, cur);
    prev = cur;
    const lim = top.qualityLimitationReason;
    return {
      role: "send",
      width: top.frameWidth ?? null,
      height: top.frameHeight ?? null,
      fps: Math.round(top.framesPerSecond ?? 0) || r.fps,
      bitrateKbps: r.kbps,
      codec: pub?.mimeType?.replace(/^video\//i, "") ?? null,
      limitation:
        lim === "none" || lim === "cpu" || lim === "bandwidth" ? lim : lim ? "other" : null,
      layer: list.length > 1 ? top.rid || null : "single",
      subscription: null,
    };
  };
}

/** Eventos do `room` que dizem se o fluxo de uma faixa remota parou (pausa do SFU) ou foi silenciado. */
function flowWatcher(room: Room | null, sid: string | undefined) {
  return (cb: (s: FlowState) => void) => {
    if (!room || !sid) return () => {};
    const onState = (pub: RemoteTrackPublication, state: Track.StreamState) => {
      if (pub.trackSid === sid) cb(state === Track.StreamState.Paused ? "paused" : "flowing");
    };
    const onMuted = (pub: { trackSid: string }) => {
      if (pub.trackSid === sid) cb("muted");
    };
    const onUnmuted = (pub: { trackSid: string }) => {
      if (pub.trackSid === sid) cb("flowing");
    };
    room.on(RoomEvent.TrackStreamStateChanged, onState);
    room.on(RoomEvent.TrackMuted, onMuted);
    room.on(RoomEvent.TrackUnmuted, onUnmuted);
    return () => {
      room.off(RoomEvent.TrackStreamStateChanged, onState);
      room.off(RoomEvent.TrackMuted, onMuted);
      room.off(RoomEvent.TrackUnmuted, onUnmuted);
    };
  };
}

/** `<video>` + `track.attach`: a implementação web de `VideoSource`. */
function videoSourceOf(
  track: VideoTrack,
  muted: boolean,
  extra: {
    remote?: boolean;
    room?: Room | null;
    pub?: RemoteTrackPublication | LocalTrackPublication;
  } = {},
): VideoSource {
  const remote = !!extra.remote;
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
    stats: remote
      ? receiverStats(track as RemoteVideoTrack, extra.pub as RemoteTrackPublication | undefined)
      : senderStats(track as LocalVideoTrack, extra.pub as LocalTrackPublication | undefined),
    onFlow: flowWatcher(extra.room ?? null, extra.pub?.trackSid),
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

/** O navegador monta o grafo de áudio do microfone (AudioWorklet + MediaStreamDestination)? Base da porta de ruído. */
export function supportsAudioGraph(): boolean {
  try {
    return (
      typeof AudioContext !== "undefined" &&
      typeof AudioWorkletNode !== "undefined" &&
      typeof MediaStreamAudioDestinationNode !== "undefined"
    );
  } catch {
    return false;
  }
}

/** O navegador tem o que o nível "Forte" (IA) precisa: o grafo de áudio e WASM. */
export function supportsStrongNoiseSuppression(): boolean {
  try {
    return supportsAudioGraph() && typeof WebAssembly === "object";
  } catch {
    return false;
  }
}

const sameSensitivity = (a: InputSensitivity, b: InputSensitivity) =>
  a.mode === b.mode && a.thresholdDb === b.thresholdDb;

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
export function screenShareOptions(
  audio: boolean,
  quality?: ScreenShareQuality,
): ScreenShareCaptureOptions {
  return {
    ...(quality
      ? {
          resolution: {
            width: Math.round((quality.height * 16) / 9),
            height: quality.height,
            frameRate: quality.fps,
          },
          contentHint: quality.priority,
        }
      : {}),
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

/**
 * Opções de PUBLICAÇÃO da tela para a qualidade pedida: teto de bitrate e de fps, e a prioridade do WebRTC quando
 * a banda aperta (`detail` = mantém a resolução e derruba fps; `motion` = mantém o fps e derruba resolução).
 * Sem simulcast para tela (ver abaixo): quem tem rede ruim depende da estimativa de banda do SFU, que pausa/retoma
 * a faixa inteira; o `dynacast` ainda para de codificar quando ninguém assiste. O servidor só repassa pacotes.
 */
export function screenSharePublishOptions(q: ScreenShareQuality): TrackPublishOptions {
  return {
    // Sem simulcast: a camada baixa da lib (metade da resolução) era entregue a quem assistia em tile pequeno e
    // ficava borrada ao ampliar até a camada alta subir. Uma única camada, sempre na resolução escolhida.
    simulcast: false,
    screenShareEncoding: { maxBitrate: estimateUplinkKbps(q) * 1000, maxFramerate: q.fps },
    degradationPreference: q.priority === "detail" ? "maintain-resolution" : "maintain-framerate",
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
  /** Volume (0 a 1) por identidade e origem; reaplicado a cada faixa que a pessoa (re)publica. */
  private volumes = new Map<string, Partial<Record<AudioSource, number>>>();
  /** Processador de microfone atual da faixa publicada (porta de ruído e/ou RNNoise). */
  private micProcessor: MicTrackProcessor | null = null;
  /** O medidor de nível está ligado (evento `input-level`). */
  private monitorOn = false;
  /** Medição só da faixa da chamada ligada pelo controlador (anel de "falando" do próprio usuário). */
  private callMeter = false;
  /** Captura de teste separada (medidor fora da chamada, ou com o microfone mudo). */
  private monitor: MicPipeline | null = null;
  private tester = new MicTester();
  readonly audioCapabilities: AudioCapabilities = {
    ...(supportsStrongNoiseSuppression()
      ? { strongNoiseSuppression: true }
      : {
          strongNoiseSuppression: false,
          strongUnavailableReason: t("voice.engine.unavailableHere"),
        }),
    participantVolume: { max: WEB_MAX_PARTICIPANT_VOLUME },
    inputSensitivity: supportsAudioGraph(),
    micTest: supportsAudioGraph() && typeof MediaRecorder !== "undefined",
    screenShareQuality: true,
    pictureInPicture: supportsPictureInPicture(),
    screenWatch: true,
    screenSourceSwap: true,
    connectionStats: true,
  };
  /** Identidades cuja tela o usuário escolheu assistir; as demais telas ficam sem assinatura (economiza banda). */
  private watching = new Set<string>();

  get state(): ConnectionState {
    return this.room ? mapState(this.room.state) : "disconnected";
  }

  async connect({ url, token }: ConnectParams): Promise<void> {
    await this.disconnect();
    // `pixelDensity: "screen"`: o tile é medido em pixels físicos (tela de alta densidade pede camada maior).
    const room = new Room({ adaptiveStream: { pixelDensity: "screen" }, dynacast: true });
    this.room = room;
    this.closing = false;
    this.wire(room);
    try {
      // Assinatura manual: tudo é assinado, menos a tela de quem o usuário ainda não escolheu assistir.
      await room.connect(url, token, { autoSubscribe: false });
    } catch (err) {
      this.teardown(room);
      throw toConnectError(err);
    }
    // Quem já estava na sala.
    for (const p of room.remoteParticipants.values()) {
      this.syncSubscriptions(p);
      this.emit("participant-joined", { identity: p.identity });
    }
  }

  /** Política de assinatura: a tela (vídeo e áudio) só com "Assistir"; todo o resto é assinado. */
  private wantSubscribed(source: Track.Source, identity: string): boolean {
    if (source === Track.Source.ScreenShare || source === Track.Source.ScreenShareAudio)
      return this.watching.has(identity);
    return true;
  }

  private syncSubscriptions(p: RemoteParticipant) {
    for (const pub of p.trackPublications?.values() ?? []) this.syncSubscription(pub, p.identity);
  }

  private syncSubscription(pub: RemoteTrackPublication, identity: string) {
    const want = this.wantSubscribed(pub.source, identity);
    // `isDesired` (o pedido em andamento) e não `isSubscribed`: assistir e parar antes de a faixa chegar precisa
    // cancelar o pedido, senão a assinatura "fantasma" chega depois e a tela fica assinada sem ninguém olhando.
    if ((pub.isDesired ?? pub.isSubscribed) === want) return;
    try {
      pub.setSubscribed(want);
    } catch {
      // a publicação pode ter sumido entre o evento e a chamada
    }
  }

  setScreenWatching(identity: string, on: boolean) {
    if (on) this.watching.add(identity);
    else this.watching.delete(identity);
    const p = this.room?.remoteParticipants.get(identity);
    if (p) this.syncSubscriptions(p);
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
    this.micProcessor = null;
    this.watching.clear();
    this.refreshMonitor();
  }

  private wire(room: Room) {
    room
      .on(RoomEvent.ParticipantConnected, (p) => {
        this.syncSubscriptions(p);
        this.emit("participant-joined", { identity: p.identity });
      })
      .on(RoomEvent.TrackPublished, (pub, p) => this.syncSubscription(pub, p.identity))
      .on(RoomEvent.ParticipantDisconnected, (p) =>
        this.emit("participant-left", { identity: p.identity }),
      )
      .on(RoomEvent.SignalConnected, () => markJoin("signal"))
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
      // A lib reaplica o volume salvo ao assinar, mas ignora 0; por isso o valor é aplicado aqui também.
      const source: AudioSource = pub.source === Track.Source.ScreenShareAudio ? "screen" : "voice";
      const volume = this.volumes.get(identity)?.[source];
      if (volume !== undefined) (track as RemoteAudioTrack).setVolume?.(volume);
      return;
    }
    const kind = kindOf(pub.source);
    if (!kind) return;
    // Tela: sempre a melhor camada (o tamanho do tile não decide a qualidade de quem assiste a texto e código).
    if (kind === "screen") {
      try {
        pub.setVideoQuality(VideoQuality.HIGH);
      } catch {
        // a publicação pode ter sumido entre o evento e a chamada
      }
    }
    this.emit("video-track-added", {
      id: pub.trackSid,
      identity,
      kind,
      local: false,
      source: videoSourceOf(track as VideoTrack, true, { remote: true, room: this.room, pub }),
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
      source: videoSourceOf(track as VideoTrack, true, { room: this.room, pub }),
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
    if (!this.room) throw new VoiceConnectError("unknown", t("voice.engine.noRoom"));
    return this.room;
  }

  /** Microfone aberto antes de a sala conectar (ver `prepareMicrophone`); consumido por `setMicrophoneEnabled(true)`. */
  private prepared: Promise<LocalAudioTrack> | null = null;

  prepareMicrophone(): void {
    this.discardPreparedMicrophone();
    markJoin("prep:start");
    const job = this.capturePrepared();
    // O erro só é reportado quando (e se) alguém consumir o preparo; sem isso seria "unhandled rejection".
    job.catch(() => {});
    this.prepared = job;
  }

  discardPreparedMicrophone(): void {
    const old = this.prepared;
    this.prepared = null;
    // Solta o dispositivo (a luz de "microfone em uso" apaga) mesmo se a captura ainda estava terminando.
    void old?.then((track) => track.stop()).catch(() => {});
  }

  prewarm(url?: string): void {
    if (url) void new Room().prepareConnection(url);
    const ap = loadAudioProcessing();
    if (
      supportsAudioGraph() &&
      (ap.noiseSuppression === "strong" || ap.inputSensitivity.mode !== "off")
    )
      void import("./noise-processor")
        .then((m) => m.preloadNoiseAssets(ap.noiseSuppression === "strong"))
        .catch(() => {});
  }

  /** Captura o microfone com as opções vigentes e já põe o processador (RNNoise/porta), sem sala. */
  private async capturePrepared(): Promise<LocalAudioTrack> {
    const deviceId = loadDevicePrefs().audioinput;
    const levelAtStart = this.level;
    const track = await createLocalAudioTrack({
      ...micConstraints(this.audio, this.level),
      ...(deviceId && deviceId !== "default" ? { deviceId: { ideal: deviceId } } : {}),
    });
    try {
      await this.syncProcessor(track);
      // A IA foi rebaixada durante o preparo: a captura precisa das constraints do nível novo.
      if (this.level !== levelAtStart)
        await track.restartTrack(micConstraints(this.audio, this.level));
    } catch (err) {
      track.stop();
      throw err;
    }
    markJoin("prep:end");
    return track;
  }

  async setMicrophoneEnabled(enabled: boolean) {
    const lp = this.requireRoom().localParticipant;
    const prepared = enabled ? this.prepared : null;
    if (prepared) this.prepared = null;
    try {
      if (prepared) {
        const track = await prepared;
        try {
          await lp.publishTrack(track, { source: Track.Source.Microphone });
        } catch (err) {
          track.stop();
          throw err;
        }
      } else {
        const pub = await lp.setMicrophoneEnabled(
          enabled,
          enabled ? micConstraints(this.audio, this.level) : undefined,
        );
        if (enabled) await this.syncProcessor(pub?.audioTrack as LocalAudioTrack | undefined);
      }
    } catch (err) {
      throw toMediaError(err, "microphone");
    }
    this.refreshMonitor();
  }

  async setAudioProcessing(options: AudioProcessingOptions): Promise<void> {
    const prev = this.audio;
    const wantsStrong = options.noiseSuppression === "strong";
    const unsupported = wantsStrong && !this.audioCapabilities.strongNoiseSuppression;
    const sensitivity = this.audioCapabilities.inputSensitivity
      ? options.inputSensitivity
      : DEFAULT_AUDIO_PROCESSING.inputSensitivity;
    this.audio = unsupported
      ? { ...options, noiseSuppression: "standard", inputSensitivity: sensitivity }
      : { ...options, inputSensitivity: sensitivity };
    this.level = this.audio.noiseSuppression;
    if (unsupported)
      this.setStatus({
        level: "standard",
        state: "degraded",
        reason: t("voice.engine.aiUnsupported"),
      });
    else this.setStatus({ level: this.level, state: "idle" });
    const captureSame =
      prev.echoCancellation === this.audio.echoCancellation &&
      prev.autoGainControl === this.audio.autoGainControl &&
      prev.noiseSuppression === this.audio.noiseSuppression;
    const sensitivitySame = sameSensitivity(prev.inputSensitivity, this.audio.inputSensitivity);
    if (captureSame && sensitivitySame) return;
    if (captureSame) {
      // Só a porta mudou: reconfigura o grafo em curso (ou o cria/remove) sem recapturar o microfone.
      this.monitor?.configure(this.audio.inputSensitivity);
      await this.enqueueMic(() => this.syncProcessor(this.micTrack()));
      return;
    }
    await this.enqueueMic(() => this.reapplyMic());
    if (this.monitor) this.refreshMonitor(true);
  }

  private enqueueMic(job: () => Promise<void>): Promise<void> {
    const run = this.micQueue.then(job, job);
    this.micQueue = run.catch(() => {});
    return run;
  }

  private setStatus(status: AudioProcessingStatus) {
    this.emit("audio-processing-status", status);
  }

  /** A faixa do microfone publicada (ligada ou muda), se houver. */
  private micTrack(): LocalAudioTrack | undefined {
    const lp = this.room?.localParticipant;
    return lp?.getTrackPublication(Track.Source.Microphone)?.audioTrack as
      | LocalAudioTrack
      | undefined;
  }

  /** Há microfone ABERTO na chamada (faixa publicada e não muda)? */
  private liveMicTrack(): LocalAudioTrack | undefined {
    const pub = this.room?.localParticipant.getTrackPublication(Track.Source.Microphone);
    return pub && !pub.isMuted ? (pub.audioTrack as LocalAudioTrack | undefined) : undefined;
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
        this.micProcessor = null;
        return;
      }
      // O RNNoise é fixo na vida do processador: trocar "Forte" por outro nível (ou o inverso) recria o grafo.
      if (track.getProcessor() && this.micProcessor?.strong !== (this.level === "strong"))
        await track.stopProcessor();
      await track.restartTrack(micConstraints(this.audio, this.level));
      await this.syncProcessor(track);
    } catch (err) {
      await this.degrade(this.reasonOf(err));
    }
  }

  /**
   * Coloca, reconfigura ou tira o processador do microfone conforme o que está em efeito: RNNoise (nível "Forte"),
   * porta de ruído (sensibilidade) e/ou medição para o medidor. Os três moram no MESMO processador/grafo.
   */
  private async syncProcessor(track: LocalAudioTrack | undefined) {
    if (!track) return;
    const strong = this.level === "strong";
    const sensitivity = this.audio.inputSensitivity;
    const wanted = strong || sensitivity.mode !== "off" || this.monitorOn || this.callMeter;
    if (!wanted) {
      if (track.getProcessor()) await track.stopProcessor();
      this.micProcessor = null;
      return;
    }
    if (track.getProcessor() && this.micProcessor && this.micProcessor.strong === strong) {
      this.micProcessor.configure(sensitivity);
      return;
    }
    if (track.getProcessor()) await track.stopProcessor();
    this.micProcessor = null;
    if (strong) this.setStatus({ level: "strong", state: "loading" });
    markJoin("proc:start");
    try {
      const { MicTrackProcessor, LOAD_TIMEOUT_MS } = await import("./noise-processor");
      const processor = new MicTrackProcessor({
        strong,
        sensitivity,
        onLevel: (l) => {
          if (this.monitorOn || this.callMeter) this.emit("input-level", l);
        },
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
      this.micProcessor = processor;
      markJoin("proc:end");
      if (strong) this.setStatus({ level: "strong", state: "active", load: "ok" });
    } catch (err) {
      if (strong) await this.degrade(this.reasonOf(err));
      else await this.dropGate(err);
    }
  }

  private reasonOf(err: unknown): string {
    const detail = err instanceof Error && err.message ? ` (${err.message})` : "";
    return t("voice.engine.aiFailed", { detail });
  }

  /** A porta de ruído não subiu (sem AudioWorklet, p.ex.): segue sem ela e avisa. */
  private async dropGate(err: unknown) {
    const detail = err instanceof Error && err.message ? ` (${err.message})` : "";
    this.audio = {
      ...this.audio,
      inputSensitivity: { ...this.audio.inputSensitivity, mode: "off" },
    };
    this.micProcessor = null;
    this.setStatus({
      level: this.level,
      state: "idle",
      gateError: t("voice.engine.gateFailed", { detail }),
    });
    await this.micTrack()
      ?.stopProcessor()
      .catch(() => {});
  }

  /** A IA não rodou (ou ficou lenta): volta para "Padrão" sem mexer na chamada e avisa. */
  private async degrade(reason: string) {
    if (this.level !== "strong") return;
    this.level = "standard";
    this.audio = { ...this.audio, noiseSuppression: "standard" };
    this.micProcessor = null;
    this.setStatus({ level: "standard", state: "degraded", reason });
    const lp = this.room?.localParticipant;
    const track = lp?.getTrackPublication(Track.Source.Microphone)?.audioTrack as
      | LocalAudioTrack
      | undefined;
    if (!track) return;
    try {
      await track.stopProcessor().catch(() => {});
      if (!lp?.getTrackPublication(Track.Source.Microphone)?.isMuted) {
        await track.restartTrack(micConstraints(this.audio, "standard"));
        // a porta de ruído (se ligada) continua valendo, agora sem o RNNoise
        await this.syncProcessor(track);
      }
    } catch (err) {
      console.warn("voz: falha ao voltar ao filtro Padrão", err);
    }
  }

  // ---- Medidor de nível e teste de microfone ----

  async setInputLevelMonitor(enabled: boolean, opts?: { callOnly?: boolean }): Promise<void> {
    if (opts?.callOnly) {
      if (this.callMeter === enabled) return;
      this.callMeter = enabled;
      // Só reconfigura a faixa que já existe; a que for publicada depois já nasce com (ou sem) o medidor.
      await this.enqueueMic(() => this.syncProcessor(this.liveMicTrack() ?? this.micTrack()));
      return;
    }
    this.monitorOn = enabled;
    if (!enabled) {
      this.monitor?.stop();
      this.monitor = null;
      await this.enqueueMic(() => this.syncProcessor(this.micTrack()));
      return;
    }
    await this.startMonitor();
  }

  /** Reavalia a fonte do medidor (faixa da chamada ou captura de teste) quando o microfone liga/desliga. */
  private refreshMonitor(restart = false) {
    if (!this.monitorOn || this.tester.running) return;
    void this.startMonitor(restart).catch(() => {});
  }

  private async startMonitor(restart = false) {
    const live = this.liveMicTrack();
    if (live) {
      this.monitor?.stop();
      this.monitor = null;
      await this.enqueueMic(() => this.syncProcessor(live));
      return;
    }
    if (this.monitor && !restart) return;
    this.monitor?.stop();
    this.monitor = null;
    const pipeline = this.newPipeline();
    this.monitor = pipeline;
    try {
      await pipeline.start();
    } catch (err) {
      if (this.monitor === pipeline) this.monitor = null;
      throw toMediaError(err, "microphone");
    }
  }

  /** Captura de teste com o MESMO processamento da chamada. */
  private pipelineOptions(onLevel: (l: InputLevel) => void): PipelineOptions {
    return {
      constraints: {
        echoCancellation: this.audio.echoCancellation,
        autoGainControl: this.audio.autoGainControl,
        noiseSuppression: this.level === "standard",
      },
      deviceId: loadDevicePrefs().audioinput,
      strong: this.level === "strong",
      sensitivity: this.audio.inputSensitivity,
      onLevel,
    };
  }

  private newPipeline() {
    return new MicPipeline(
      this.pipelineOptions((l) => {
        if (this.monitorOn) this.emit("input-level", l);
      }),
    );
  }

  async startMicTest(): Promise<void> {
    if (this.tester.running) return;
    if (this.liveMicTrack()) {
      // O alto-falante tocaria a gravação para a chamada inteira ouvir: a interface pede para silenciar antes.
      this.emit("mic-test", { phase: "error", error: "in-use" });
      return;
    }
    this.monitor?.stop();
    this.monitor = null;
    await this.tester.run(
      {
        ...this.pipelineOptions((l) => this.emit("input-level", l)),
        outputDeviceId: loadDevicePrefs().audiooutput,
        durationMs: MIC_TEST_DURATION_MS,
      },
      (state) => this.emit("mic-test", state),
    );
    this.refreshMonitor();
  }

  cancelMicTest(): void {
    this.tester.cancel();
  }

  async setCameraEnabled(enabled: boolean) {
    const lp = this.requireRoom().localParticipant;
    try {
      await lp.setCameraEnabled(enabled);
    } catch (err) {
      throw toMediaError(err, "camera");
    }
  }

  async replaceScreenShareSource(opts: { audio?: boolean } = {}) {
    const lp = this.requireRoom().localParticipant;
    const pub = lp.getTrackPublication(Track.Source.ScreenShare);
    const track = pub?.videoTrack;
    if (!pub || !track) throw new VoiceMediaError("unknown", "screen", t("voice.engine.noScreen"));
    const q = track.mediaStreamTrack?.getSettings?.();
    const height = q?.height;
    try {
      // Mesma qualidade da transmissão em curso: a captura nova pede o que a antiga entregava.
      const fresh = await lp.createScreenTracks(
        screenShareOptions(
          !!opts.audio,
          height
            ? {
                height: height >= 1440 ? 1440 : height >= 1080 ? 1080 : 720,
                fps: (q?.frameRate ?? 30) >= 60 ? 60 : (q?.frameRate ?? 30) >= 30 ? 30 : 15,
                priority: "detail",
              }
            : undefined,
        ),
      );
      const video = fresh.find((t) => t.kind === Track.Kind.Video);
      for (const t of fresh) if (t !== video) t.stop();
      if (!video) throw new VoiceMediaError("unknown", "screen");
      // A publicação (sid, codec, bitrate) continua; só a captura por baixo troca.
      await track.replaceTrack(video.mediaStreamTrack, { userProvidedTrack: false });
    } catch (err) {
      throw toMediaError(err, "screen");
    }
  }

  async getConnectionStats(): Promise<ConnectionStats | null> {
    const room = this.room;
    if (!room || room.state !== LkConnectionState.Connected) return null;
    const lp = room.localParticipant;
    let rttMs: number | null = null;
    let jitterMs: number | null = null;
    let lost = 0;
    let total = 0;
    type Sender = {
      roundTripTime?: number;
      jitter?: number;
      packetsLost?: number;
      packetsSent?: number;
    };
    const read = async (track: { getSenderStats?: () => Promise<unknown> } | undefined) => {
      const raw = await track?.getSenderStats?.().catch(() => undefined);
      const list = (Array.isArray(raw) ? raw : raw ? [raw] : []) as Sender[];
      for (const stats of list) {
        if (typeof stats.roundTripTime === "number")
          rttMs = Math.max(rttMs ?? 0, stats.roundTripTime * 1000);
        if (typeof stats.jitter === "number")
          jitterMs = Math.max(jitterMs ?? 0, stats.jitter * 1000);
        lost += stats.packetsLost ?? 0;
        total += (stats.packetsSent ?? 0) + (stats.packetsLost ?? 0);
      }
    };
    await read(this.micTrack());
    for (const src of [Track.Source.Camera, Track.Source.ScreenShare])
      await read(lp.getTrackPublication(src)?.videoTrack);
    // Sem nada publicado (só ouvindo) o RTT sai do par de candidatos da conexão do assinante.
    if (rttMs === null) {
      const rtt = await this.subscriberRtt(room);
      if (rtt !== null) rttMs = rtt;
    }
    if (rttMs === null && jitterMs === null && total === 0) return null;
    return {
      rttMs: rttMs === null ? null : Math.round(rttMs),
      jitterMs: jitterMs === null ? null : Math.round(jitterMs * 10) / 10,
      lossPct: total > 0 ? Math.round((lost / total) * 1000) / 10 : null,
    };
  }

  private async subscriberRtt(room: Room): Promise<number | null> {
    try {
      const pc = (
        room as unknown as {
          engine?: { pcManager?: { subscriber?: { getStats?: () => Promise<RTCStatsReport> } } };
        }
      ).engine?.pcManager?.subscriber;
      const report = await pc?.getStats?.();
      if (!report) return null;
      let rtt: number | null = null;
      report.forEach((v) => {
        const r = v as {
          type?: string;
          state?: string;
          nominated?: boolean;
          currentRoundTripTime?: number;
        };
        if (
          r.type === "candidate-pair" &&
          (r.nominated || r.state === "succeeded") &&
          typeof r.currentRoundTripTime === "number"
        )
          rtt = r.currentRoundTripTime * 1000;
      });
      return rtt;
    } catch {
      return null;
    }
  }

  async setScreenShareEnabled(
    enabled: boolean,
    opts: { audio?: boolean; quality?: ScreenShareQuality } = {},
  ) {
    const lp = this.requireRoom().localParticipant;
    try {
      await lp.setScreenShareEnabled(
        enabled,
        enabled ? screenShareOptions(!!opts.audio, opts.quality) : undefined,
        enabled && opts.quality ? screenSharePublishOptions(opts.quality) : undefined,
      );
    } catch (err) {
      throw toMediaError(err, "screen");
    }
  }

  setDeafened(deafened: boolean) {
    this.deafened = deafened;
    for (const el of this.audioEls.values()) el.muted = deafened;
  }

  /**
   * Volume local de uma pessoa (0 a 1: `HTMLMediaElement.volume` não passa de 1). É independente do deafen, que
   * mexe em `muted`: ensurdecido continua silenciando tudo, qualquer que seja o volume.
   */
  setParticipantVolume(identity: string, source: AudioSource, volume: number) {
    const v = Math.min(
      WEB_MAX_PARTICIPANT_VOLUME,
      Math.max(0, Number.isFinite(volume) ? volume : 1),
    );
    this.volumes.set(identity, { ...this.volumes.get(identity), [source]: v });
    this.room?.remoteParticipants.get(identity)?.setVolume(v, sourceOfAudio(source));
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
