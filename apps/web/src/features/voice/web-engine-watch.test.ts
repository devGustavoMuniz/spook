import { beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceMediaError } from "./engine";

// Assinatura de telas, troca de fonte e estatísticas de rede da engine web, com a livekit-client simulada.
const lk = vi.hoisted(() => {
  const RoomEvent = {
    ParticipantConnected: "pc",
    ParticipantDisconnected: "pd",
    TrackPublished: "tp",
    TrackSubscribed: "ts",
    TrackUnsubscribed: "tu",
    Disconnected: "dc",
  } as Record<string, string>;
  type Pub = {
    source: string;
    isSubscribed: boolean;
    calls: boolean[];
    setSubscribed(v: boolean): void;
  };
  const pub = (source: string): Pub => ({
    source,
    isSubscribed: false,
    calls: [],
    setSubscribed(v) {
      this.calls.push(v);
      this.isSubscribed = v;
    },
  });
  class FakeRoom {
    static last: FakeRoom;
    static connectOpts: unknown;
    state = "connected";
    handlers = new Map<string, ((...a: unknown[]) => void)[]>();
    remoteParticipants = new Map<
      string,
      { identity: string; trackPublications: Map<string, Pub> }
    >();
    screen = {
      replaced: [] as unknown[],
      videoTrack: {
        mediaStreamTrack: { getSettings: () => ({ height: 1080, frameRate: 30 }) },
        async replaceTrack(t: unknown, o: unknown) {
          lk.screen.replaced.push([t, o]);
        },
      },
    };
    created: unknown[] = [];
    failCreate: Error | null = null;
    localParticipant = {
      isMicrophoneEnabled: false,
      getTrackPublication: (s: string) =>
        s === "screen_share" ? { videoTrack: FakeRoom.last.screen.videoTrack } : undefined,
      createScreenTracks: async (o: unknown) => {
        if (FakeRoom.last.failCreate) throw FakeRoom.last.failCreate;
        FakeRoom.last.created.push(o);
        return [{ kind: "video", mediaStreamTrack: { id: "new" }, stop() {} }];
      },
    };
    constructor() {
      FakeRoom.last = this;
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
    async connect(_u: string, _t: string, o: unknown) {
      FakeRoom.connectOpts = o;
    }
    async disconnect() {}
    static async getLocalDevices() {
      return [];
    }
  }
  const screen = { replaced: [] as unknown[] };
  return { RoomEvent, Room: FakeRoom, pub, screen };
});

vi.mock("livekit-client", () => ({
  Room: lk.Room,
  RoomEvent: lk.RoomEvent,
  ConnectionError: class extends Error {},
  ConnectionQuality: {},
  ConnectionState: {
    Connected: "connected",
    Connecting: "connecting",
    Reconnecting: "reconnecting",
    Disconnected: "disconnected",
  },
  DisconnectReason: {},
  Track: {
    Kind: { Audio: "audio", Video: "video" },
    Source: {
      Camera: "camera",
      ScreenShare: "screen_share",
      Microphone: "microphone",
      ScreenShareAudio: "screen_share_audio",
    },
  },
}));
vi.mock("./noise-processor", () => ({ createMicProcessor: vi.fn(), unsupported: vi.fn() }));

import { createWebVoiceEngine } from "./web-engine";

const URL = { url: "wss://x", token: "t" };
type FakePub = ReturnType<typeof lk.pub>;

function joinWith(room: InstanceType<typeof lk.Room>, id: string, ...sources: string[]) {
  const pubs = new Map<string, FakePub>(sources.map((s) => [s, lk.pub(s)]));
  const p = { identity: id, trackPublications: pubs };
  room.remoteParticipants.set(id, p);
  room.emit(lk.RoomEvent.ParticipantConnected as string, p);
  return pubs;
}

beforeEach(() => {
  lk.screen.replaced.length = 0;
});

describe("assistir telas", () => {
  it("declara a capacidade e conecta sem assinar tudo automaticamente", async () => {
    const e = createWebVoiceEngine();
    await e.connect(URL);
    expect(e.audioCapabilities?.screenWatch).toBe(true);
    expect(lk.Room.connectOpts).toMatchObject({ autoSubscribe: false });
  });

  it("assina voz e câmera, mas não a tela (nem o áudio dela) até assistir", async () => {
    const e = createWebVoiceEngine();
    await e.connect(URL);
    const pubs = joinWith(
      lk.Room.last,
      "7",
      "microphone",
      "camera",
      "screen_share",
      "screen_share_audio",
    );
    expect(pubs.get("microphone")?.isSubscribed).toBe(true);
    expect(pubs.get("camera")?.isSubscribed).toBe(true);
    expect(pubs.get("screen_share")?.isSubscribed).toBe(false);
    expect(pubs.get("screen_share_audio")?.isSubscribed).toBe(false);
  });

  it("assistir assina vídeo e áudio da tela; parar de assistir cancela", async () => {
    const e = createWebVoiceEngine();
    await e.connect(URL);
    const pubs = joinWith(lk.Room.last, "7", "microphone", "screen_share", "screen_share_audio");
    e.setScreenWatching?.("7", true);
    expect(pubs.get("screen_share")?.isSubscribed).toBe(true);
    expect(pubs.get("screen_share_audio")?.isSubscribed).toBe(true);
    e.setScreenWatching?.("7", false);
    expect(pubs.get("screen_share")?.isSubscribed).toBe(false);
    expect(pubs.get("microphone")?.isSubscribed).toBe(true);
  });

  it("uma tela publicada depois respeita quem já estava sendo assistido", async () => {
    const e = createWebVoiceEngine();
    await e.connect(URL);
    const room = lk.Room.last;
    const p = { identity: "7", trackPublications: new Map<string, FakePub>() };
    room.remoteParticipants.set("7", p);
    e.setScreenWatching?.("7", true);
    const late = lk.pub("screen_share");
    const other = lk.pub("screen_share");
    room.emit(lk.RoomEvent.TrackPublished as string, late, { identity: "7" });
    room.emit(lk.RoomEvent.TrackPublished as string, other, { identity: "9" });
    expect(late.isSubscribed).toBe(true);
    expect(other.isSubscribed).toBe(false);
  });

  it("sair da sala esquece quem estava sendo assistido", async () => {
    const e = createWebVoiceEngine();
    await e.connect(URL);
    e.setScreenWatching?.("7", true);
    await e.disconnect();
    await e.connect(URL);
    const pubs = joinWith(lk.Room.last, "7", "screen_share");
    expect(pubs.get("screen_share")?.isSubscribed).toBe(false);
  });
});

describe("trocar a fonte da tela", () => {
  it("captura de novo com a qualidade em curso e troca a faixa da mesma publicação", async () => {
    const e = createWebVoiceEngine();
    await e.connect(URL);
    await e.replaceScreenShareSource?.({ audio: false });
    expect(lk.Room.last.created).toHaveLength(1);
    expect(lk.Room.last.created[0]).toMatchObject({ resolution: { height: 1080, frameRate: 30 } });
    expect(lk.screen.replaced).toEqual([[{ id: "new" }, { userProvidedTrack: false }]]);
  });

  it("cancelar o seletor vira VoiceMediaError cancelled e não troca nada", async () => {
    const e = createWebVoiceEngine();
    await e.connect(URL);
    const err = new Error("x");
    err.name = "NotAllowedError";
    lk.Room.last.failCreate = err;
    await expect(e.replaceScreenShareSource?.()).rejects.toMatchObject({ code: "cancelled" });
    await expect(e.replaceScreenShareSource?.()).rejects.toBeInstanceOf(VoiceMediaError);
    expect(lk.screen.replaced).toHaveLength(0);
  });
});

describe("estatísticas de rede", () => {
  it("agrega RTT, jitter e perda das faixas publicadas", async () => {
    const e = createWebVoiceEngine();
    await e.connect(URL);
    const room = lk.Room.last;
    (
      room.screen.videoTrack as unknown as { getSenderStats: () => Promise<unknown> }
    ).getSenderStats = async () => [
      { roundTripTime: 0.05, jitter: 0.004, packetsLost: 2, packetsSent: 98 },
      { roundTripTime: 0.08, jitter: 0.002, packetsLost: 0, packetsSent: 100 },
    ];
    const stats = await e.getConnectionStats?.();
    expect(stats).toEqual({ rttMs: 80, jitterMs: 4, lossPct: 1 });
  });

  it("sem nada medido devolve null", async () => {
    const e = createWebVoiceEngine();
    expect(await e.getConnectionStats?.()).toBeNull();
    await e.connect(URL);
    expect(await e.getConnectionStats?.()).toBeNull();
  });
});
