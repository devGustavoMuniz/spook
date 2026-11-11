import {
  type AudioCapabilities,
  type AudioSource,
  type ConnectionState,
  type ConnectionStats,
  type ConnectParams,
  type DeviceInfo,
  type DeviceKind,
  Emitter,
  type ScreenShareQuality,
  type VideoTrackInfo,
  type VoiceEngine,
  type VoiceEngineEvents,
  type VoiceMediaError,
} from "@/features/voice/engine";

/** Dublê de `VoiceEngine` para testes: registra chamadas e deixa o teste disparar eventos. */
export class FakeVoiceEngine extends Emitter<VoiceEngineEvents> implements VoiceEngine {
  state: ConnectionState = "disconnected";
  connects: ConnectParams[] = [];
  calls: string[] = [];
  mic = false;
  camera = false;
  screen = false;
  deafened = false;
  /** Capacidades de áudio que a engine declara (testes mudam isto). */
  audioCapabilities?: AudioCapabilities;
  devices: Record<DeviceKind, DeviceInfo[]> = {
    audioinput: [{ id: "mic1", label: "Microfone USB" }],
    audiooutput: [{ id: "spk1", label: "Caixa de som" }],
    videoinput: [{ id: "cam1", label: "Webcam" }],
  };
  setDevices: [DeviceKind, string][] = [];
  /** Volumes por pessoa recebidos (`setParticipantVolume`), em ordem. */
  volumes: [string, AudioSource, number][] = [];
  /** `setInputLevelMonitor` e `startMicTest`/`cancelMicTest`, em ordem. */
  monitorCalls: boolean[] = [];
  micTests = 0;
  micTestCancels = 0;
  /** Opções da última chamada de `setScreenShareEnabled(true, ...)`. */
  lastScreenOpts: { audio?: boolean; quality?: ScreenShareQuality } | undefined;
  /** `setScreenWatching`, `replaceScreenShareSource` e `getConnectionStats` (lote 2). */
  watches: [string, boolean][] = [];
  swaps: ({ audio?: boolean } | undefined)[] = [];
  failSwap: VoiceMediaError | null = null;
  stats: ConnectionStats | null = null;
  /** Falhas programadas por operação: o próximo `connect`/mic/câmera/tela lança isto. */
  failConnect: Error | null = null;
  failConnectOnce: Error | null = null;
  failMic: VoiceMediaError | null = null;
  failCamera: VoiceMediaError | null = null;
  failScreen: VoiceMediaError | null = null;

  async connect(p: ConnectParams) {
    this.calls.push("connect");
    if (this.state !== "disconnected") await this.disconnect();
    this.connects.push(p);
    if (this.failConnectOnce) {
      const e = this.failConnectOnce;
      this.failConnectOnce = null;
      throw e;
    }
    if (this.failConnect) throw this.failConnect;
    this.state = "connected";
  }

  async disconnect() {
    if (this.state === "disconnected") return;
    this.calls.push("disconnect");
    this.state = "disconnected";
    this.mic = this.camera = this.screen = false;
    this.emit("disconnected", { reason: "client" });
  }

  async setMicrophoneEnabled(on: boolean) {
    if (on && this.failMic) throw this.failMic;
    this.calls.push(`mic:${on}`);
    this.mic = on;
  }
  /** O servidor mutou: a faixa publicada é descartada (a próxima ligada publica uma nova). */
  async resetMicrophone() {
    this.calls.push("mic:reset");
  }
  async setCameraEnabled(on: boolean) {
    if (on && this.failCamera) throw this.failCamera;
    this.calls.push(`camera:${on}`);
    this.camera = on;
  }
  async setScreenShareEnabled(
    on: boolean,
    opts?: { audio?: boolean; quality?: ScreenShareQuality },
  ) {
    if (on && this.failScreen) throw this.failScreen;
    if (on) this.lastScreenOpts = opts;
    this.calls.push(`screen:${on}:${opts?.audio ? "audio" : "mudo"}`);
    this.screen = on;
  }
  setDeafened(d: boolean) {
    this.calls.push(`deaf:${d}`);
    this.deafened = d;
  }
  setScreenWatching(identity: string, on: boolean) {
    this.watches.push([identity, on]);
  }
  async replaceScreenShareSource(opts?: { audio?: boolean }) {
    if (this.failSwap) throw this.failSwap;
    this.swaps.push(opts);
  }
  async getConnectionStats() {
    return this.stats;
  }
  setParticipantVolume(identity: string, source: AudioSource, volume: number) {
    this.volumes.push([identity, source, volume]);
  }
  async setInputLevelMonitor(enabled: boolean, opts?: { callOnly?: boolean }) {
    if (opts?.callOnly) this.callMeterCalls.push(enabled);
    else this.monitorCalls.push(enabled);
  }
  /** Microfone preparado antes de conectar (`prepareMicrophone`), descartes e pré-aquecimentos. */
  prepares = 0;
  discards = 0;
  prewarms: (string | undefined)[] = [];
  /** `setInputLevelMonitor(_, { callOnly: true })`, em ordem. */
  callMeterCalls: boolean[] = [];
  prepareMicrophone() {
    this.prepares++;
    this.calls.push("prepare-mic");
  }
  discardPreparedMicrophone() {
    this.discards++;
  }
  prewarm(url?: string) {
    this.prewarms.push(url);
  }
  async startMicTest() {
    this.micTests++;
  }
  cancelMicTest() {
    this.micTestCancels++;
  }
  async resumeAudio() {
    this.calls.push("resume-audio");
  }
  async listDevices(kind: DeviceKind) {
    return this.devices[kind];
  }
  async setDevice(kind: DeviceKind, id: string) {
    this.setDevices.push([kind, id]);
  }

  // ---- ajudantes do teste ----
  fire<K extends keyof VoiceEngineEvents>(event: K, payload: VoiceEngineEvents[K]) {
    this.emit(event, payload);
  }
  /** A sala caiu sem o app pedir (servidor removeu, rede). */
  drop(reason: "removed" | "network" | "unknown") {
    this.state = "disconnected";
    this.emit("disconnected", { reason });
  }
  videoTrack(id: string, identity: string, kind: "camera" | "screen", local = false) {
    const attached: HTMLElement[] = [];
    const track: VideoTrackInfo = {
      id,
      identity,
      kind,
      local,
      source: {
        attach(host) {
          const el = document.createElement("canvas");
          el.dataset.track = id;
          host.appendChild(el);
          attached.push(el);
          return () => el.remove();
        },
      },
    };
    this.emit("video-track-added", track);
    return track;
  }
}
