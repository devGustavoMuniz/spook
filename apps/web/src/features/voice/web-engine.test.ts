import { beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceConnectError, VoiceMediaError } from "./engine";

// livekit-client simulado: uma Room mínima com emissor de eventos, para exercitar o mapeamento
// (eventos da lib -> eventos da interface VoiceEngine) sem WebRTC.
const lk = vi.hoisted(() => {
  const RoomEvent = {
    ParticipantConnected: "pc",
    ParticipantDisconnected: "pd",
    ActiveSpeakersChanged: "as",
    TrackSubscribed: "ts",
    TrackUnsubscribed: "tu",
    LocalTrackPublished: "ltp",
    LocalTrackUnpublished: "ltu",
    TrackMuted: "tm",
    TrackUnmuted: "tum",
    Reconnecting: "rc",
    Reconnected: "rcd",
    ConnectionQualityChanged: "cq",
    AudioPlaybackStatusChanged: "aps",
    MediaDevicesChanged: "mdc",
    Disconnected: "dc",
  };
  class ConnectionError extends Error {
    constructor(
      m: string,
      readonly status?: number,
    ) {
      super(m);
    }
  }
  /** Track de microfone local mínimo: registra recapturas e o processador de IA. */
  function fakeAudioTrack() {
    return {
      restarts: [] as unknown[],
      processor: undefined as undefined | { name: string },
      failSetProcessor: null as Error | null,
      failRestart: null as Error | null,
      async restartTrack(opts: unknown) {
        if (this.failRestart) throw this.failRestart;
        this.restarts.push(opts);
      },
      getProcessor() {
        return this.processor;
      },
      async setProcessor(p: { name: string }) {
        if (this.failSetProcessor) throw this.failSetProcessor;
        this.processor = p;
      },
      async stopProcessor() {
        this.processor = undefined;
      },
    };
  }
  /** Processador de IA simulado (o módulo real exige AudioWorklet/WASM, ausentes no jsdom). */
  const noise = {
    created: [] as { hooks: { onLoad?: (l: string) => void; onSlow?: () => void } }[],
    timeout: 20_000,
  };
  class FakeRoom {
    static last: FakeRoom;
    static seed: string[] = [];
    static devices = [{ deviceId: "d1", label: "" }];
    handlers = new Map<string, ((...a: unknown[]) => void)[]>();
    remoteParticipants = new Map<string, { identity: string }>();
    state = "connected";
    canPlaybackAudio = true;
    connectError: Error | null = null;
    disconnected = 0;
    switched: [string, string][] = [];
    localParticipant = {
      isMicrophoneEnabled: false,
      isCameraEnabled: false,
      isScreenShareEnabled: false,
      calls: [] as unknown[],
      fail: null as Error | null,
      micCalls: [] as [boolean, unknown][],
      micPub: null as null | {
        source: string;
        isMuted: boolean;
        audioTrack: ReturnType<typeof fakeAudioTrack>;
      },
      unpublished: [] as unknown[],
      async setMicrophoneEnabled(on: boolean, opts?: unknown) {
        if (this.fail) throw this.fail;
        this.micCalls.push([on, opts]);
        this.isMicrophoneEnabled = on;
        if (on && !this.micPub)
          this.micPub = { source: "microphone", isMuted: false, audioTrack: fakeAudioTrack() };
        else if (this.micPub) this.micPub.isMuted = !on;
        return this.micPub ?? undefined;
      },
      getTrackPublication(source: string) {
        return source === "microphone" ? (this.micPub ?? undefined) : undefined;
      },
      async unpublishTrack(track: unknown) {
        this.unpublished.push(track);
        this.micPub = null;
      },
      async setCameraEnabled(on: boolean) {
        if (this.fail) throw this.fail;
        this.isCameraEnabled = on;
      },
      async setScreenShareEnabled(on: boolean, opts?: unknown) {
        if (this.fail) throw this.fail;
        this.calls.push(["screen", on, opts]);
        this.isScreenShareEnabled = on;
      },
    };
    constructor() {
      FakeRoom.last = this;
      for (const id of FakeRoom.seed) this.remoteParticipants.set(id, { identity: id });
    }
    on(ev: string, h: (...a: unknown[]) => void) {
      this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), h]);
      return this;
    }
    removeAllListeners() {
      this.handlers.clear();
    }
    emit(ev: string, ...a: unknown[]) {
      for (const h of this.handlers.get(ev) ?? []) h(...a);
    }
    async connect() {
      if (this.connectError) throw this.connectError;
    }
    async disconnect() {
      this.disconnected++;
    }
    async startAudio() {}
    async switchActiveDevice(kind: string, id: string) {
      this.switched.push([kind, id]);
    }
    static async getLocalDevices() {
      return FakeRoom.devices;
    }
  }
  return {
    noise,
    Room: FakeRoom,
    RoomEvent,
    ConnectionError,
    ConnectionQuality: {
      Excellent: "excellent",
      Good: "good",
      Poor: "poor",
      Lost: "lost",
      Unknown: "unknown",
    },
    ConnectionState: {
      Connected: "connected",
      Connecting: "connecting",
      Reconnecting: "reconnecting",
      SignalReconnecting: "signalReconnecting",
      Disconnected: "disconnected",
    },
    DisconnectReason: {
      CLIENT_INITIATED: 1,
      DUPLICATE_IDENTITY: 2,
      SERVER_SHUTDOWN: 3,
      PARTICIPANT_REMOVED: 4,
      ROOM_DELETED: 5,
      STATE_MISMATCH: 6,
      JOIN_FAILURE: 7,
      MIGRATION: 8,
      SIGNAL_CLOSE: 9,
      ROOM_CLOSED: 10,
      CONNECTION_TIMEOUT: 14,
      MEDIA_FAILURE: 15,
    },
    Track: {
      Kind: { Audio: "audio", Video: "video" },
      Source: { Camera: "camera", ScreenShare: "screen_share", Microphone: "microphone" },
    },
  };
});
vi.mock("livekit-client", () => lk);
vi.mock("./noise-processor", () => ({
  get LOAD_TIMEOUT_MS() {
    return lk.noise.timeout;
  },
  RnnoiseTrackProcessor: class {
    name = "spook-rnnoise";
    constructor(public hooks: { onLoad?: (l: string) => void; onSlow?: () => void }) {
      lk.noise.created.push(this);
    }
  },
}));

import type { AudioProcessingOptions, AudioProcessingStatus } from "./engine";
import {
  createWebVoiceEngine,
  mapDisconnectReason,
  micConstraints,
  screenShareOptions,
  toMediaError,
} from "./web-engine";

const room = () => lk.Room.last;
const URL = { url: "ws://x", token: "t" };

function track(kind: "audio" | "video") {
  const els: HTMLElement[] = [];
  return {
    kind,
    els,
    attach(el?: HTMLElement) {
      const e = el ?? document.createElement(kind === "audio" ? "audio" : "video");
      els.push(e);
      return e;
    },
    detach(el?: HTMLElement) {
      const i = els.indexOf(el as HTMLElement);
      if (i >= 0) els.splice(i, 1);
    },
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
  lk.noise.created.length = 0;
  lk.noise.timeout = 20_000;
  vi.unstubAllGlobals();
});

/** jsdom não tem AudioWorklet nem WASM de áudio: declara que o navegador os tem (a engine só confere a existência). */
function stubAudioWorklet() {
  vi.stubGlobal("AudioContext", class {});
  vi.stubGlobal("AudioWorkletNode", class {});
  vi.stubGlobal("MediaStreamAudioDestinationNode", class {});
}

const opts = (over: Partial<AudioProcessingOptions> = {}): AudioProcessingOptions => ({
  echoCancellation: true,
  noiseSuppression: "standard",
  autoGainControl: true,
  ...over,
});

describe("conexão", () => {
  it("conecta e anuncia quem já estava na sala", async () => {
    const e = createWebVoiceEngine();
    const joined: string[] = [];
    e.on("participant-joined", (p) => joined.push(p.identity));
    lk.Room.seed = ["7"];
    await e.connect(URL);
    lk.Room.seed = [];
    expect(e.state).toBe("connected");
    expect(joined).toEqual(["7"]);
  });

  it("token recusado (401) vira VoiceConnectError token-rejected", async () => {
    const e = createWebVoiceEngine();
    const orig = lk.Room.prototype.connect;
    lk.Room.prototype.connect = async () => {
      throw new lk.ConnectionError("no auth", 401);
    };
    await expect(e.connect(URL)).rejects.toMatchObject({ code: "token-rejected" });
    await expect(e.connect(URL)).rejects.toBeInstanceOf(VoiceConnectError);
    lk.Room.prototype.connect = orig;
    expect(e.state).toBe("disconnected");
  });

  it("outro erro de conexão: unreachable", async () => {
    const e = createWebVoiceEngine();
    const orig = lk.Room.prototype.connect;
    lk.Room.prototype.connect = async () => {
      throw new lk.ConnectionError("timeout", 500);
    };
    await expect(e.connect(URL)).rejects.toMatchObject({ code: "unreachable" });
    lk.Room.prototype.connect = orig;
  });

  it("disconnect() emite 'client' uma vez e é idempotente", async () => {
    const e = createWebVoiceEngine();
    await e.connect(URL);
    const reasons: string[] = [];
    e.on("disconnected", (d) => reasons.push(d.reason));
    const r = room();
    await e.disconnect();
    await e.disconnect();
    expect(reasons).toEqual(["client"]);
    expect(r.disconnected).toBe(1);
  });

  it("desconexão da lib vira o motivo da interface", async () => {
    const e = createWebVoiceEngine();
    await e.connect(URL);
    const reasons: string[] = [];
    e.on("disconnected", (d) => reasons.push(d.reason));
    room().emit(lk.RoomEvent.Disconnected, lk.DisconnectReason.PARTICIPANT_REMOVED);
    expect(reasons).toEqual(["removed"]);
    expect(e.state).toBe("disconnected");
  });

  it("mapeia os motivos de desconexão", () => {
    const D = lk.DisconnectReason;
    expect(mapDisconnectReason(D.CLIENT_INITIATED as never)).toBe("client");
    expect(mapDisconnectReason(D.ROOM_DELETED as never)).toBe("removed");
    expect(mapDisconnectReason(D.DUPLICATE_IDENTITY as never)).toBe("removed");
    expect(mapDisconnectReason(D.SIGNAL_CLOSE as never)).toBe("network");
    expect(mapDisconnectReason(D.CONNECTION_TIMEOUT as never)).toBe("network");
    expect(mapDisconnectReason(undefined)).toBe("unknown");
  });

  it("reconexão e qualidade do enlace local", async () => {
    const e = createWebVoiceEngine();
    await e.connect(URL);
    const seen: string[] = [];
    e.on("connection-state", (s) => seen.push(s.state));
    e.on("link-quality", (q) => seen.push(q.quality));
    room().emit(lk.RoomEvent.Reconnecting);
    room().emit(lk.RoomEvent.Reconnected);
    room().emit(lk.RoomEvent.ConnectionQualityChanged, "poor", { isLocal: true });
    room().emit(lk.RoomEvent.ConnectionQualityChanged, "lost", { isLocal: false });
    expect(seen).toEqual(["reconnecting", "connected", "poor"]);
  });
});

describe("participantes e mídia remota", () => {
  it("entra, sai e quem está falando", async () => {
    const e = createWebVoiceEngine();
    await e.connect(URL);
    const log: string[] = [];
    e.on("participant-joined", (p) => log.push(`+${p.identity}`));
    e.on("participant-left", (p) => log.push(`-${p.identity}`));
    e.on("speakers-changed", (s) => log.push(`fala:${s.identities.join(",")}`));
    room().emit(lk.RoomEvent.ParticipantConnected, { identity: "2" });
    room().emit(lk.RoomEvent.ActiveSpeakersChanged, [{ identity: "2" }]);
    room().emit(lk.RoomEvent.ParticipantDisconnected, { identity: "2" });
    expect(log).toEqual(["+2", "fala:2", "-2"]);
  });

  it("vídeo remoto: VideoSource monta um <video> no host e desfaz", async () => {
    const e = createWebVoiceEngine();
    await e.connect(URL);
    const added: { id: string; kind: string; source: { attach(h: HTMLElement): () => void } }[] =
      [];
    const removed: string[] = [];
    e.on("video-track-added", (t) => added.push(t));
    e.on("video-track-removed", (t) => removed.push(t.id));
    const v = track("video");
    const pub = { trackSid: "TR1", source: "screen_share" };
    room().emit(lk.RoomEvent.TrackSubscribed, v, pub, { identity: "2" });
    expect(added).toMatchObject([{ id: "TR1", kind: "screen", identity: "2", local: false }]);
    const host = document.createElement("div");
    const detach = added[0]?.source.attach(host);
    expect(host.querySelector("video")).not.toBeNull();
    expect(v.els).toHaveLength(1);
    detach?.();
    detach?.();
    expect(host.querySelector("video")).toBeNull();
    expect(v.els).toHaveLength(0);
    room().emit(lk.RoomEvent.TrackUnsubscribed, v, pub);
    expect(removed).toEqual(["TR1"]);
  });

  it("áudio remoto toca em elementos próprios; ensurdecer silencia e novos já entram mudos", async () => {
    const e = createWebVoiceEngine();
    await e.connect(URL);
    const a1 = track("audio");
    room().emit(
      lk.RoomEvent.TrackSubscribed,
      a1,
      { trackSid: "A1", source: "microphone" },
      { identity: "2" },
    );
    const el1 = a1.els[0] as HTMLMediaElement;
    expect(document.querySelector("[data-voice-audio]")?.contains(el1)).toBe(true);
    expect(el1.muted).toBe(false);
    e.setDeafened(true);
    expect(el1.muted).toBe(true);
    const a2 = track("audio");
    room().emit(
      lk.RoomEvent.TrackSubscribed,
      a2,
      { trackSid: "A2", source: "microphone" },
      { identity: "3" },
    );
    expect((a2.els[0] as HTMLMediaElement).muted).toBe(true);
    e.setDeafened(false);
    expect(el1.muted).toBe(false);
    room().emit(lk.RoomEvent.TrackUnsubscribed, a1, { trackSid: "A1" });
    expect(document.body.contains(el1)).toBe(false);
  });

  it("áudio bloqueado pelo navegador é sinalizado", async () => {
    const e = createWebVoiceEngine();
    await e.connect(URL);
    const seen: boolean[] = [];
    e.on("audio-blocked", (b) => seen.push(b.blocked));
    room().canPlaybackAudio = false;
    room().emit(lk.RoomEvent.AudioPlaybackStatusChanged);
    expect(seen).toEqual([true]);
  });
});

describe("mídia local", () => {
  it("liga mic, câmera e tela (com áudio) e publica a prévia local", async () => {
    const e = createWebVoiceEngine();
    await e.connect(URL);
    const media: unknown[] = [];
    const tracks: { local: boolean; kind: string }[] = [];
    e.on("local-media", (m) => media.push(m));
    e.on("video-track-added", (t) => tracks.push(t));
    await e.setMicrophoneEnabled(true);
    await e.setScreenShareEnabled(true, { audio: true });
    expect(room().localParticipant.calls).toMatchObject([
      ["screen", true, { audio: { suppressLocalAudioPlayback: true }, systemAudio: "include" }],
    ]);
    room().emit(
      lk.RoomEvent.LocalTrackPublished,
      { trackSid: "L1", source: "camera", track: track("video") },
      { identity: "1" },
    );
    expect(tracks).toMatchObject([{ local: true, kind: "camera" }]);
    expect(media.at(-1)).toEqual({ microphone: true, camera: false, screenShare: true });
  });

  it("parar a tela pelo navegador remove a faixa e atualiza o estado local", async () => {
    const e = createWebVoiceEngine();
    await e.connect(URL);
    const removed: string[] = [];
    let media: unknown;
    e.on("video-track-removed", (t) => removed.push(t.id));
    e.on("local-media", (m) => {
      media = m;
    });
    room().localParticipant.isScreenShareEnabled = false;
    room().emit(lk.RoomEvent.LocalTrackUnpublished, { trackSid: "L2", source: "screen_share" });
    expect(removed).toEqual(["L2"]);
    expect(media).toMatchObject({ screenShare: false });
  });

  it.each([
    ["NotAllowedError", "microphone", "permission-denied"],
    ["NotAllowedError", "screen", "cancelled"],
    ["NotFoundError", "camera", "not-found"],
    ["NotReadableError", "camera", "in-use"],
    ["Qualquer", "microphone", "unknown"],
  ] as const)("erro %s em %s vira %s", (name, device, code) => {
    const err = new Error("x");
    err.name = name;
    expect(toMediaError(err, device)).toMatchObject({ code, device });
  });

  it("falha do navegador sobe como VoiceMediaError", async () => {
    const e = createWebVoiceEngine();
    await e.connect(URL);
    const err = new Error("negado");
    err.name = "NotAllowedError";
    room().localParticipant.fail = err;
    await expect(e.setMicrophoneEnabled(true)).rejects.toBeInstanceOf(VoiceMediaError);
    await expect(e.setScreenShareEnabled(true)).rejects.toMatchObject({ code: "cancelled" });
  });
});

describe("dispositivos", () => {
  it("lista com rótulo padrão e troca o ativo na sala", async () => {
    const e = createWebVoiceEngine();
    expect(await e.listDevices("audioinput")).toEqual([
      { id: "d1", label: "Dispositivo sem nome" },
    ]);
    await e.connect(URL);
    await e.setDevice("audiooutput", "spk");
    expect(room().switched).toEqual([["audiooutput", "spk"]]);
  });
});

describe("microfone: constraints por nível", () => {
  it.each([
    ["off", { noiseSuppression: false, voiceIsolation: false }],
    ["standard", { noiseSuppression: true, voiceIsolation: true }],
    ["strong", { noiseSuppression: false, voiceIsolation: false }],
  ] as const)("nível %s", (level, expected) => {
    expect(micConstraints(opts({ noiseSuppression: level }), level)).toMatchObject({
      echoCancellation: true,
      autoGainControl: true,
      ...expected,
    });
  });

  it("eco e ganho seguem os interruptores, independentes do ruído", () => {
    expect(
      micConstraints(opts({ echoCancellation: false, autoGainControl: false }), "standard"),
    ).toMatchObject({ echoCancellation: false, autoGainControl: false, noiseSuppression: true });
  });

  it("o microfone é aberto com as constraints do que foi pedido", async () => {
    const e = createWebVoiceEngine();
    await e.connect(URL);
    await e.setAudioProcessing?.(opts({ noiseSuppression: "off", echoCancellation: false }));
    await e.setMicrophoneEnabled(true);
    expect(room().localParticipant.micCalls[0]).toEqual([
      true,
      {
        echoCancellation: false,
        autoGainControl: true,
        noiseSuppression: false,
        voiceIsolation: false,
      },
    ]);
  });
});

describe("microfone: troca de nível durante a chamada", () => {
  async function inCall(level: AudioProcessingOptions["noiseSuppression"] = "standard") {
    const e = createWebVoiceEngine();
    await e.connect(URL);
    await e.setAudioProcessing?.(opts({ noiseSuppression: level }));
    await e.setMicrophoneEnabled(true);
    const mic = room().localParticipant.micPub?.audioTrack;
    if (!mic) throw new Error("sem track de microfone");
    return { e, mic };
  }

  it("recaptura só o microfone, sem desconectar nem republicar", async () => {
    const { e, mic } = await inCall();
    const disconnected: unknown[] = [];
    e.on("disconnected", (d) => disconnected.push(d));
    await e.setAudioProcessing?.(opts({ noiseSuppression: "off" }));
    expect(mic.restarts).toEqual([
      {
        echoCancellation: true,
        autoGainControl: true,
        noiseSuppression: false,
        voiceIsolation: false,
      },
    ]);
    expect(room().disconnected).toBe(0);
    expect(disconnected).toEqual([]);
    expect(room().localParticipant.unpublished).toEqual([]);
  });

  it("ligar/desligar eco recaptura; repetir o mesmo valor não faz nada", async () => {
    const { e, mic } = await inCall();
    await e.setAudioProcessing?.(opts());
    expect(mic.restarts).toHaveLength(0);
    await e.setAudioProcessing?.(opts({ echoCancellation: false }));
    expect(mic.restarts).toHaveLength(1);
    expect(mic.restarts[0]).toMatchObject({ echoCancellation: false });
  });

  it("mudo: descarta o track (sem capturar) e a próxima ativação já usa o nível novo", async () => {
    const { e, mic } = await inCall();
    await e.setMicrophoneEnabled(false);
    await e.setAudioProcessing?.(opts({ noiseSuppression: "off" }));
    expect(mic.restarts).toHaveLength(0); // não reabriu o microfone enquanto mudo
    expect(room().localParticipant.unpublished).toEqual([mic]);
    await e.setMicrophoneEnabled(true);
    expect(room().localParticipant.micCalls.at(-1)).toEqual([
      true,
      expect.objectContaining({ noiseSuppression: false }),
    ]);
  });
});

describe("microfone: nível Forte (IA)", () => {
  it("anuncia a capacidade conforme o navegador", () => {
    expect(createWebVoiceEngine().audioCapabilities).toMatchObject({
      strongNoiseSuppression: false,
      strongUnavailableReason: expect.any(String),
    });
    stubAudioWorklet();
    expect(createWebVoiceEngine().audioCapabilities).toEqual({ strongNoiseSuppression: true });
  });

  it("liga o processador no track com o filtro do navegador desligado", async () => {
    stubAudioWorklet();
    const e = createWebVoiceEngine();
    const statuses: AudioProcessingStatus[] = [];
    e.on("audio-processing-status", (s) => statuses.push(s));
    await e.connect(URL);
    await e.setAudioProcessing?.(opts({ noiseSuppression: "strong" }));
    await e.setMicrophoneEnabled(true);
    const mic = room().localParticipant.micPub?.audioTrack;
    expect(mic?.processor?.name).toBe("spook-rnnoise");
    expect(room().localParticipant.micCalls[0]?.[1]).toMatchObject({
      noiseSuppression: false,
      voiceIsolation: false,
      echoCancellation: true,
    });
    expect(statuses.map((s) => s.state)).toEqual(["idle", "loading", "active"]);
    expect(statuses.at(-1)).toEqual({ level: "strong", state: "active", load: "ok" });
  });

  it("padrão -> forte durante a chamada: recaptura sem o filtro e acopla o processador", async () => {
    stubAudioWorklet();
    const e = createWebVoiceEngine();
    await e.connect(URL);
    await e.setAudioProcessing?.(opts());
    await e.setMicrophoneEnabled(true);
    const mic = room().localParticipant.micPub?.audioTrack;
    await e.setAudioProcessing?.(opts({ noiseSuppression: "strong" }));
    expect(mic?.restarts.at(-1)).toMatchObject({ noiseSuppression: false });
    expect(mic?.processor?.name).toBe("spook-rnnoise");
    // e de volta: tira o processador e devolve o filtro do navegador
    await e.setAudioProcessing?.(opts());
    expect(mic?.processor).toBeUndefined();
    expect(mic?.restarts.at(-1)).toMatchObject({ noiseSuppression: true });
    expect(room().disconnected).toBe(0);
  });

  it("sem AudioWorklet/WASM: cai para Padrão com aviso, sem processador", async () => {
    const e = createWebVoiceEngine();
    const statuses: AudioProcessingStatus[] = [];
    e.on("audio-processing-status", (s) => statuses.push(s));
    await e.connect(URL);
    await e.setAudioProcessing?.(opts({ noiseSuppression: "strong" }));
    await e.setMicrophoneEnabled(true);
    expect(statuses[0]).toMatchObject({ level: "standard", state: "degraded" });
    expect(statuses[0]?.reason).toMatch(/não suporta/);
    expect(room().localParticipant.micPub?.audioTrack.processor).toBeUndefined();
    expect(room().localParticipant.micCalls[0]?.[1]).toMatchObject({ noiseSuppression: true });
  });

  it("falha ao carregar o modelo: volta para Padrão com aviso e recaptura com o filtro", async () => {
    stubAudioWorklet();
    const e = createWebVoiceEngine();
    const statuses: AudioProcessingStatus[] = [];
    e.on("audio-processing-status", (s) => statuses.push(s));
    await e.connect(URL);
    await e.setAudioProcessing?.(opts({ noiseSuppression: "standard" }));
    await e.setMicrophoneEnabled(true);
    const mic = room().localParticipant.micPub?.audioTrack;
    if (!mic) throw new Error("sem track");
    mic.failSetProcessor = new Error("falha de rede");
    await e.setAudioProcessing?.(opts({ noiseSuppression: "strong" }));
    const last = statuses.at(-1);
    expect(last).toMatchObject({ level: "standard", state: "degraded" });
    expect(last?.reason).toMatch(/falha de rede/);
    expect(mic.processor).toBeUndefined();
    expect(mic.restarts.at(-1)).toMatchObject({ noiseSuppression: true });
  });

  it("modelo que não carrega a tempo: rebaixa", async () => {
    stubAudioWorklet();
    lk.noise.timeout = 5;
    const e = createWebVoiceEngine();
    const statuses: AudioProcessingStatus[] = [];
    e.on("audio-processing-status", (s) => statuses.push(s));
    await e.connect(URL);
    await e.setAudioProcessing?.(opts());
    await e.setMicrophoneEnabled(true);
    const mic = room().localParticipant.micPub?.audioTrack;
    if (!mic) throw new Error("sem track");
    mic.setProcessor = () => new Promise(() => {}); // nunca resolve
    await e.setAudioProcessing?.(opts({ noiseSuppression: "strong" }));
    expect(statuses.at(-1)).toMatchObject({ state: "degraded" });
    expect(statuses.at(-1)?.reason).toMatch(/tempo esgotado/);
  });

  it("processamento lento demais (aviso do monitor) rebaixa para Padrão", async () => {
    stubAudioWorklet();
    const e = createWebVoiceEngine();
    const statuses: AudioProcessingStatus[] = [];
    e.on("audio-processing-status", (s) => statuses.push(s));
    await e.connect(URL);
    await e.setAudioProcessing?.(opts({ noiseSuppression: "strong" }));
    await e.setMicrophoneEnabled(true);
    const mic = room().localParticipant.micPub?.audioTrack;
    lk.noise.created[0]?.hooks.onLoad?.("high");
    expect(statuses.at(-1)).toMatchObject({ state: "active", load: "high" });
    lk.noise.created[0]?.hooks.onSlow?.();
    await vi.waitFor(() => expect(statuses.at(-1)?.state).toBe("degraded"));
    expect(statuses.at(-1)?.reason).toMatch(/lento demais/);
    expect(mic?.processor).toBeUndefined();
    expect(mic?.restarts.at(-1)).toMatchObject({ noiseSuppression: true });
  });
});

describe("compartilhamento de tela: opções contra eco", () => {
  it("sem áudio (padrão): nada de áudio de sistema, sem a própria aba, reprodução local suprimida", () => {
    expect(screenShareOptions(false)).toEqual({
      audio: false,
      selfBrowserSurface: "exclude",
      systemAudio: "exclude",
      suppressLocalAudioPlayback: true,
    });
  });

  it("com áudio: áudio de sistema, sem eco de reprodução e sem o som da própria aba", () => {
    expect(screenShareOptions(true)).toMatchObject({
      selfBrowserSurface: "exclude",
      systemAudio: "include",
      suppressLocalAudioPlayback: true,
      audio: {
        suppressLocalAudioPlayback: true,
        restrictOwnAudio: true,
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
  });

  it("setScreenShareEnabled sem opts não pede áudio; desligar não manda opções", async () => {
    const e = createWebVoiceEngine();
    await e.connect(URL);
    await e.setScreenShareEnabled(true);
    await e.setScreenShareEnabled(false);
    const calls = room().localParticipant.calls;
    expect(calls[0]).toMatchObject([
      "screen",
      true,
      { audio: false, selfBrowserSurface: "exclude" },
    ]);
    expect(calls[1]).toEqual(["screen", false, undefined]);
  });
});
