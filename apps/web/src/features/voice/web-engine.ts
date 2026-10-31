// Engine web: livekit-client (WebRTC do navegador). Único arquivo que conhece a lib (ver engine.ts).
import {
  ConnectionError,
  ConnectionQuality,
  ConnectionState as LkConnectionState,
  DisconnectReason as LkDisconnectReason,
  type LocalTrackPublication,
  type Participant,
  type RemoteTrack,
  type RemoteTrackPublication,
  Room,
  RoomEvent,
  Track,
  type VideoTrack,
} from "livekit-client";
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

export class WebVoiceEngine extends Emitter<VoiceEngineEvents> implements VoiceEngine {
  private room: Room | null = null;
  private deafened = false;
  private audioEls = new Map<string, HTMLMediaElement>();
  private audioHost: HTMLElement | null = null;
  /** Evita emitir `disconnected` duas vezes (por `disconnect()` e pelo evento da lib). */
  private closing = false;

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
        if (pub.trackSid) this.emit("video-track-removed", { id: pub.trackSid });
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
      await lp.setMicrophoneEnabled(enabled);
    } catch (err) {
      throw toMediaError(err, "microphone");
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
      await lp.setScreenShareEnabled(enabled, enabled ? { audio: !!opts.audio } : undefined);
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
