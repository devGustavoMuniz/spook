import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type VideoTrackInfo,
  VoiceConnectError,
  type VoiceEngineEvents,
  VoiceMediaError,
} from "@/features/voice/engine";
import { mediaMessage } from "@/features/voice/media-errors";
import type { FrameHeader } from "./frame-wire";
import { type NativeDeps, type NativeEvent, NativeVoiceEngine } from "./native-engine";
import type { ScreenSource } from "./screen-picker";

/** Monta um quadro como o Rust (`wire.rs`): [u32 LE N][JSON][JPEG]. */
function frame(trackId: string, jpeg = [0xff, 0xd8, 1, 0xff, 0xd9], w = 640, h = 360) {
  const header: FrameHeader = {
    trackId,
    participantId: "42",
    source: "screen",
    width: w,
    height: h,
    timestamp: 1,
  };
  const json = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(4 + json.length + jpeg.length);
  new DataView(out.buffer).setUint32(0, json.length, true);
  out.set(json, 4);
  out.set(jpeg, 4 + json.length);
  return out.buffer;
}

type Call = { cmd: string; args?: Record<string, unknown> };

/** invoke/Channel simulados: o "Rust" é um objeto que responde por comando. */
function fakeRust() {
  const calls: Call[] = [];
  const channels: { onmessage: (m: never) => void }[] = [];
  const handlers = new Map<string, (args?: Record<string, unknown>) => unknown>();
  let picked: string | null = "display:1";
  const deps: NativeDeps = {
    invoke: (async (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      const h = handlers.get(cmd);
      if (h) return h(args);
      if (cmd === "voice_list_screen_sources") {
        return [{ id: "display:1", name: "Tela 1", kind: "screen" }] satisfies ScreenSource[];
      }
      return undefined;
    }) as NativeDeps["invoke"],
    createChannel: (async (onmessage: (m: never) => void) => {
      const c = { onmessage };
      channels.push(c);
      return c;
    }) as unknown as NativeDeps["createChannel"],
    pickScreenSource: vi.fn(async () => picked),
  };
  return {
    deps,
    calls,
    channels,
    on: (cmd: string, h: (args?: Record<string, unknown>) => unknown) => handlers.set(cmd, h),
    pick: (id: string | null) => {
      picked = id;
    },
    /** Evento enviado pelo Rust no canal da sala (o primeiro canal criado). */
    emit: (e: NativeEvent, channel = 0) => channels[channel]?.onmessage(e as never),
    named: (cmd: string) => calls.filter((c) => c.cmd === cmd),
  };
}

function setup() {
  const rust = fakeRust();
  const engine = new NativeVoiceEngine(rust.deps);
  const seen: { [K in keyof VoiceEngineEvents]?: VoiceEngineEvents[K][] } = {};
  for (const k of [
    "participant-joined",
    "participant-left",
    "speakers-changed",
    "video-track-added",
    "video-track-removed",
    "connection-state",
    "link-quality",
    "local-media",
    "audio-blocked",
    "devices-changed",
    "disconnected",
    "input-level",
    "mic-test",
  ] as const) {
    engine.on(k, (p) => {
      // biome-ignore lint/suspicious/noExplicitAny: coletor genérico de eventos de teste
      const bag = seen as any;
      bag[k] = [...(bag[k] ?? []), p];
    });
  }
  return { rust, engine, seen };
}

const OFF = { mode: "off", thresholdDb: -50 } as const;

const params = { url: "wss://spook-rtc.dottadigital.com", token: "a.b.c" };

describe("NativeVoiceEngine: sala", () => {
  it("conecta pelo comando Rust e traduz os eventos do canal", async () => {
    const { rust, engine, seen } = setup();
    await engine.connect(params);
    expect(rust.named("voice_connect")).toHaveLength(1);
    expect(rust.named("voice_connect")[0]?.args).toMatchObject(params);
    expect(engine.state).toBe("connected");

    rust.emit({ type: "participant-joined", identity: "7" });
    rust.emit({ type: "participant-left", identity: "7" });
    rust.emit({ type: "speakers-changed", identities: ["1", "2"] });
    rust.emit({ type: "link-quality", quality: "poor" });
    rust.emit({ type: "connection-state", state: "reconnecting" });
    rust.emit({ type: "local-media", microphone: true, camera: false, screenShare: true });
    rust.emit({ type: "devices-changed" });

    expect(seen["participant-joined"]).toEqual([{ identity: "7" }]);
    expect(seen["participant-left"]).toEqual([{ identity: "7" }]);
    expect(seen["speakers-changed"]).toEqual([{ identities: ["1", "2"] }]);
    expect(seen["link-quality"]).toEqual([{ quality: "poor" }]);
    expect(seen["connection-state"]).toEqual([{ state: "reconnecting" }]);
    expect(engine.state).toBe("reconnecting");
    expect(seen["local-media"]).toEqual([{ microphone: true, camera: false, screenShare: true }]);
    expect(seen["devices-changed"]).toHaveLength(1);
  });

  it("encerra com o motivo vindo do Rust quando o servidor derruba a sala", async () => {
    const { rust, engine, seen } = setup();
    await engine.connect(params);
    rust.emit({ type: "disconnected", reason: "removed" });
    expect(seen.disconnected).toEqual([{ reason: "removed" }]);
    expect(engine.state).toBe("disconnected");
    // depois disso um disconnect() pedido pela UI não repete o evento
    await engine.disconnect();
    expect(seen.disconnected).toHaveLength(1);
    expect(rust.named("voice_disconnect")).toHaveLength(0);
  });

  it("disconnect é idempotente, emite 'client' uma vez e ignora eventos atrasados", async () => {
    const { rust, engine, seen } = setup();
    await engine.disconnect(); // sem sala: nada
    expect(seen.disconnected).toBeUndefined();
    await engine.connect(params);
    await engine.disconnect();
    await engine.disconnect();
    expect(seen.disconnected).toEqual([{ reason: "client" }]);
    expect(rust.named("voice_disconnect")).toHaveLength(1);
    rust.emit({ type: "participant-joined", identity: "9" });
    rust.emit({ type: "disconnected", reason: "network" });
    expect(seen["participant-joined"]).toBeUndefined();
    expect(seen.disconnected).toHaveLength(1);
  });

  it("conectar de novo encerra a sala anterior e descarta eventos do canal antigo", async () => {
    const { rust, engine, seen } = setup();
    await engine.connect(params);
    await engine.connect(params);
    expect(seen.disconnected).toEqual([{ reason: "client" }]);
    rust.emit({ type: "participant-joined", identity: "old" }, 0);
    rust.emit({ type: "participant-joined", identity: "new" }, 1);
    expect(seen["participant-joined"]).toEqual([{ identity: "new" }]);
  });

  it.each([
    [{ kind: "connect", code: "token-rejected", message: "x" }, "token-rejected"],
    [{ kind: "connect", code: "unreachable", message: "x" }, "unreachable"],
    [{ kind: "other", message: "x" }, "unknown"],
    [new Error("boom"), "unknown"],
    ["texto", "unknown"],
  ])("erro de conexão %j vira VoiceConnectError(%s)", async (err, code) => {
    const { rust, engine } = setup();
    rust.on("voice_connect", () => {
      throw err;
    });
    const e = await engine.connect(params).catch((x) => x);
    expect(e).toBeInstanceOf(VoiceConnectError);
    expect(e.code).toBe(code);
    expect(engine.state).toBe("disconnected");
    // não ficou "ativo": disconnect() não chama o Rust
    await engine.disconnect();
    expect(rust.named("voice_disconnect")).toHaveLength(0);
  });
});

describe("NativeVoiceEngine: mídia local", () => {
  it("exige sala ativa", async () => {
    const { engine } = setup();
    await expect(engine.setMicrophoneEnabled(true)).rejects.toBeInstanceOf(VoiceConnectError);
    await expect(engine.setCameraEnabled(true)).rejects.toBeInstanceOf(VoiceConnectError);
    await expect(engine.setScreenShareEnabled(true)).rejects.toBeInstanceOf(VoiceConnectError);
  });

  it("microfone, câmera e deafen chamam os comandos certos", async () => {
    const { rust, engine } = setup();
    await engine.connect(params);
    await engine.setMicrophoneEnabled(true);
    await engine.setMicrophoneEnabled(false);
    await engine.setCameraEnabled(true);
    engine.setDeafened(true);
    await engine.resumeAudio();
    expect(rust.named("voice_set_microphone").map((c) => c.args)).toEqual([
      { enabled: true },
      { enabled: false },
    ]);
    expect(rust.named("voice_set_camera_enabled")[0]?.args).toEqual({ on: true });
    expect(rust.named("voice_set_deafened")[0]?.args).toEqual({ deafened: true });
  });

  it("traduz permissão negada do SO para VoiceMediaError com a mensagem do Rust", async () => {
    const { rust, engine } = setup();
    await engine.connect(params);
    const msg =
      "O sistema bloqueou o microfone. Abra Ajustes do Sistema > Privacidade e Segurança > Microfone, ative o Spook e tente de novo.";
    rust.on("voice_set_microphone", () => {
      throw { kind: "media", code: "permission-denied", device: "microphone", message: msg };
    });
    const e = await engine.setMicrophoneEnabled(true).catch((x) => x);
    expect(e).toBeInstanceOf(VoiceMediaError);
    expect(e.code).toBe("permission-denied");
    expect(e.device).toBe("microphone");
    expect(mediaMessage(e)).toBe(msg);
    expect(mediaMessage(e)).toContain("Ajustes do Sistema > Privacidade e Segurança");
  });

  it.each([
    ["not-found", "camera"],
    ["in-use", "camera"],
    ["unsupported", "camera"],
  ] as const)("câmera: %s", async (code, device) => {
    const { rust, engine } = setup();
    await engine.connect(params);
    rust.on("voice_set_camera_enabled", () => {
      throw { kind: "media", code, device, message: `msg ${code}` };
    });
    const e = await engine.setCameraEnabled(true).catch((x) => x);
    expect(e).toBeInstanceOf(VoiceMediaError);
    expect(e.code).toBe(code);
    expect(mediaMessage(e)).toBe(`msg ${code}`);
  });

  it("erro desconhecido do Rust vira 'unknown' sem quebrar", async () => {
    const { rust, engine } = setup();
    await engine.connect(params);
    rust.on("voice_set_microphone", () => {
      throw new Error("falha qualquer");
    });
    const e = await engine.setMicrophoneEnabled(true).catch((x) => x);
    expect(e.code).toBe("unknown");
    expect(mediaMessage(e)).toBe("Não foi possível usar o microfone.");
  });
});

describe("NativeVoiceEngine: compartilhar tela", () => {
  it("lista as fontes, deixa escolher e inicia a captura nativa", async () => {
    const { rust, engine } = setup();
    await engine.connect(params);
    rust.pick("window:77");
    await engine.setScreenShareEnabled(true, { audio: true });
    expect(rust.deps.pickScreenSource).toHaveBeenCalledWith([
      { id: "display:1", name: "Tela 1", kind: "screen" },
    ]);
    expect(rust.named("voice_set_screen_share")[0]?.args).toEqual({
      on: true,
      options: { sourceId: "window:77", audio: true },
    });
  });

  it("cancelar o seletor vira 'cancelled' e não inicia a captura", async () => {
    const { rust, engine } = setup();
    await engine.connect(params);
    rust.pick(null);
    const e = await engine.setScreenShareEnabled(true).catch((x) => x);
    expect(e).toBeInstanceOf(VoiceMediaError);
    expect(e.code).toBe("cancelled");
    expect(e.device).toBe("screen");
    expect(rust.named("voice_set_screen_share")).toHaveLength(0);
    expect(mediaMessage(e)).toBe("Compartilhamento de tela cancelado.");
  });

  it("parar não abre o seletor", async () => {
    const { rust, engine } = setup();
    await engine.connect(params);
    await engine.setScreenShareEnabled(false);
    expect(rust.deps.pickScreenSource).not.toHaveBeenCalled();
    expect(rust.named("voice_set_screen_share")[0]?.args).toEqual({ on: false });
  });

  it("permissão de gravação de tela negada no macOS traz o caminho dos Ajustes", async () => {
    const { rust, engine } = setup();
    await engine.connect(params);
    rust.on("voice_set_screen_share", () => {
      throw {
        kind: "media",
        code: "permission-denied",
        device: "screen",
        message:
          "O sistema bloqueou a captura de tela. Abra Ajustes do Sistema > Privacidade e Segurança > Gravação de Tela e Áudio do Sistema.",
      };
    });
    const e = await engine.setScreenShareEnabled(true).catch((x) => x);
    expect(e.code).toBe("permission-denied");
    expect(mediaMessage(e)).toContain("Gravação de Tela");
  });
});

describe("NativeVoiceEngine: processamento de áudio", () => {
  it("envia os três interruptores ao Rust (em chamada ou não)", async () => {
    const { rust, engine } = setup();
    await engine.setAudioProcessing({
      echoCancellation: false,
      noiseSuppression: "standard",
      autoGainControl: false,
      inputSensitivity: { mode: "off", thresholdDb: -50 },
    });
    expect(rust.named("voice_set_audio_processing")[0]?.args).toEqual({
      echoCancellation: false,
      noiseSuppression: "standard",
      autoGainControl: false,
      inputSensitivity: { mode: "off", thresholdDb: -50 },
    });
  });

  it("o nível Forte existe no nativo: é declarado disponível e enviado em texto, sem cair para Padrão", async () => {
    const { rust, engine } = setup();
    expect(engine.audioCapabilities.strongNoiseSuppression).toBe(true);
    expect(engine.audioCapabilities.strongUnavailableReason).toBeUndefined();
    for (const level of ["strong", "off", "standard"] as const) {
      await engine.setAudioProcessing({
        echoCancellation: true,
        noiseSuppression: level,
        autoGainControl: true,
        inputSensitivity: { mode: "off", thresholdDb: -50 },
      });
    }
    expect(rust.named("voice_set_audio_processing").map((c) => c.args)).toEqual([
      {
        echoCancellation: true,
        noiseSuppression: "strong",
        autoGainControl: true,
        inputSensitivity: OFF,
      },
      {
        echoCancellation: true,
        noiseSuppression: "off",
        autoGainControl: true,
        inputSensitivity: OFF,
      },
      {
        echoCancellation: true,
        noiseSuppression: "standard",
        autoGainControl: true,
        inputSensitivity: OFF,
      },
    ]);
  });

  it("o desktop declara que não compartilha o áudio do sistema", () => {
    const { engine } = setup();
    expect(engine.audioCapabilities.screenShareAudio).toBe(false);
  });

  it("falha do Rust vira VoiceMediaError", async () => {
    const { rust, engine } = setup();
    rust.on("voice_set_audio_processing", () => {
      throw { kind: "other", message: "x" };
    });
    const e = await engine
      .setAudioProcessing({
        echoCancellation: true,
        noiseSuppression: "standard",
        autoGainControl: true,
        inputSensitivity: { mode: "off", thresholdDb: -50 },
      })
      .catch((x) => x);
    expect(e).toBeInstanceOf(VoiceMediaError);
  });
});

describe("NativeVoiceEngine: dispositivos", () => {
  it("lista com rótulo padrão e devolve [] se o Rust falhar", async () => {
    const { rust, engine } = setup();
    rust.on("voice_list_devices", (a) =>
      a?.kind === "audioinput"
        ? [
            { id: "Mic USB", label: "Mic USB" },
            { id: "x", label: "" },
          ]
        : (() => {
            throw new Error("sem acesso");
          })(),
    );
    expect(await engine.listDevices("audioinput")).toEqual([
      { id: "Mic USB", label: "Mic USB" },
      { id: "x", label: "Dispositivo sem nome" },
    ]);
    expect(await engine.listDevices("videoinput")).toEqual([]);
  });

  it("setDevice traduz 'default' para o padrão do sistema e funciona sem sala", async () => {
    const { rust, engine } = setup();
    await engine.setDevice("audiooutput", "Alto-falante");
    await engine.setDevice("audioinput", "default");
    expect(rust.named("voice_set_device").map((c) => c.args)).toEqual([
      { kind: "audiooutput", id: "Alto-falante" },
      { kind: "audioinput", id: "" },
    ]);
  });
});

// ---- vídeo ----

type Drawn = { w: number; h: number }[];

function stubCanvas() {
  const drawn: Drawn = [];
  const bitmaps: { close: ReturnType<typeof vi.fn> }[] = [];
  let release: (() => void) | null = null;
  let gate = false;
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async (blob: Blob) => {
      expect(blob.type).toBe("image/jpeg");
      if (gate)
        await new Promise<void>((r) => {
          release = r;
        });
      const b = { width: 640, height: 360, close: vi.fn() };
      bitmaps.push(b);
      return b;
    }),
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
    this: HTMLCanvasElement,
  ) {
    return {
      drawImage: () => drawn.push({ w: this.width, h: this.height }),
    } as unknown as CanvasRenderingContext2D;
  } as never);
  return {
    drawn,
    bitmaps,
    hold: () => {
      gate = true;
    },
    go: () => {
      gate = false;
      release?.();
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function withTrack(id = "TR_1") {
  const ctx = setup();
  await ctx.engine.connect(params);
  ctx.rust.emit({ type: "video-track-added", id, identity: "42", kind: "screen", local: false });
  const info = (ctx.seen["video-track-added"] as VideoTrackInfo[])[0] as VideoTrackInfo;
  return { ...ctx, info };
}

describe("NativeVoiceEngine: vídeo remoto em <canvas>", () => {
  let canvasApi: ReturnType<typeof stubCanvas>;
  beforeEach(() => {
    canvasApi = stubCanvas();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("expõe a faixa e só se inscreve no Rust quando alguém monta o canvas", async () => {
    const { rust, info } = await withTrack();
    expect(info).toMatchObject({ id: "TR_1", identity: "42", kind: "screen", local: false });
    expect(rust.named("voice_video_subscribe")).toHaveLength(0);

    const host = document.createElement("div");
    document.body.appendChild(host);
    const detach = info.source.attach(host);
    await tick();
    expect(host.querySelector("canvas")).not.toBeNull();
    expect(rust.named("voice_video_subscribe")).toHaveLength(1);
    expect(rust.named("voice_video_subscribe")[0]?.args).toMatchObject({ trackId: "TR_1" });

    detach();
    detach(); // idempotente
    await tick();
    expect(host.querySelector("canvas")).toBeNull();
    expect(rust.named("voice_video_unsubscribe")).toHaveLength(1);
  });

  it("vários hosts compartilham uma inscrição; só o último detach desinscreve", async () => {
    const { rust, info } = await withTrack();
    const a = document.createElement("div");
    const b = document.createElement("div");
    const da = info.source.attach(a);
    const db = info.source.attach(b);
    await tick();
    expect(rust.named("voice_video_subscribe")).toHaveLength(1);
    da();
    await tick();
    expect(rust.named("voice_video_unsubscribe")).toHaveLength(0);
    db();
    await tick();
    expect(rust.named("voice_video_unsubscribe")).toHaveLength(1);
  });

  it("desenha o JPEG recebido no canvas com a resolução do quadro e confirma (ack)", async () => {
    const { rust, info } = await withTrack();
    const host = document.createElement("div");
    info.source.attach(host);
    await tick();
    const sub = rust.channels[1] as { onmessage: (m: unknown) => void };
    sub.onmessage(frame("TR_1"));
    await tick();
    await tick();
    expect(canvasApi.drawn).toEqual([{ w: 640, h: 360 }]);
    const canvas = host.querySelector("canvas") as HTMLCanvasElement;
    expect([canvas.width, canvas.height]).toEqual([640, 360]);
    expect(canvasApi.bitmaps[0]?.close).toHaveBeenCalled();
    expect(rust.named("voice_video_ack")).toHaveLength(1);
  });

  it("backpressure: com um quadro em desenho, guarda só o mais novo e devolve os créditos", async () => {
    const { rust, info } = await withTrack();
    const host = document.createElement("div");
    info.source.attach(host);
    await tick();
    const sub = rust.channels[1] as { onmessage: (m: unknown) => void };
    canvasApi.hold();
    sub.onmessage(frame("TR_1")); // começa a decodificar e fica preso
    await tick();
    sub.onmessage(frame("TR_1")); // vira pendente
    sub.onmessage(frame("TR_1")); // substitui o pendente: o anterior é confirmado sem desenhar
    sub.onmessage(frame("TR_1")); // idem
    expect(rust.named("voice_video_ack")).toHaveLength(2);
    canvasApi.go();
    await tick();
    await tick();
    await tick();
    // desenhou o 1º e o último; os do meio foram descartados
    expect(canvasApi.drawn).toHaveLength(2);
    // todo quadro recebido foi confirmado exatamente uma vez
    expect(rust.named("voice_video_ack")).toHaveLength(4);
  });

  it("quadro corrompido ou truncado é confirmado e ignorado", async () => {
    const { rust, info } = await withTrack();
    info.source.attach(document.createElement("div"));
    await tick();
    const sub = rust.channels[1] as { onmessage: (m: unknown) => void };
    sub.onmessage(new Uint8Array([1, 2]).buffer);
    sub.onmessage(new Uint8Array([200, 0, 0, 0, 1]).buffer);
    sub.onmessage("lixo");
    await tick();
    expect(canvasApi.drawn).toHaveLength(0);
    expect(rust.named("voice_video_ack")).toHaveLength(3);
  });

  it("detach antes de a inscrição terminar não deixa o Rust enviando", async () => {
    const { rust, info } = await withTrack();
    const detach = info.source.attach(document.createElement("div"));
    detach(); // antes do await do createChannel
    await tick();
    await tick();
    expect(rust.named("voice_video_subscribe")).toHaveLength(0);
  });

  it("faixa removida desinscreve e emite video-track-removed", async () => {
    const { rust, info, seen } = await withTrack();
    info.source.attach(document.createElement("div"));
    await tick();
    rust.emit({ type: "video-track-removed", id: "TR_1" });
    await tick();
    expect(seen["video-track-removed"]).toEqual([{ id: "TR_1" }]);
    expect(rust.named("voice_video_unsubscribe")).toHaveLength(1);
  });

  it("a prévia local pede uma resolução menor", async () => {
    const { rust } = setup();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const ctx = setup();
    await ctx.engine.connect(params);
    ctx.rust.emit({
      type: "video-track-added",
      id: "local:camera",
      identity: "1",
      kind: "camera",
      local: true,
    });
    const info = (ctx.seen["video-track-added"] as VideoTrackInfo[])[0] as VideoTrackInfo;
    expect(info.local).toBe(true);
    info.source.attach(document.createElement("div"));
    await tick();
    expect(ctx.rust.named("voice_video_subscribe")[0]?.args).toMatchObject({
      trackId: "local:camera",
      options: { maxWidth: 640, maxHeight: 360 },
    });
    expect(rust.calls).toHaveLength(0);
  });

  it("desconectar desinscreve todas as faixas", async () => {
    const { rust, info, engine } = await withTrack();
    info.source.attach(document.createElement("div"));
    await tick();
    await engine.disconnect();
    await tick();
    expect(rust.named("voice_video_unsubscribe")).toHaveLength(1);
  });
});

describe("NativeVoiceEngine: capacidades do contrato adicional", () => {
  it("declara volume até 200%, porta, teste de microfone e qualidade da tela; PiP e prévia da tela desligados", () => {
    const { engine } = setup();
    expect(engine.audioCapabilities).toEqual({
      strongNoiseSuppression: true,
      screenShareAudio: false,
      participantVolume: { max: 2 },
      inputSensitivity: true,
      micTest: true,
      screenShareQuality: true,
      screenSharePreview: false,
      pictureInPicture: false,
    });
  });
});

describe("NativeVoiceEngine: volume por pessoa", () => {
  it("envia identidade, origem e volume ao Rust", () => {
    const { rust, engine } = setup();
    engine.setParticipantVolume("7", "voice", 1.5);
    engine.setParticipantVolume("7", "screen", 0);
    expect(rust.named("voice_set_participant_volume").map((c) => c.args)).toEqual([
      { identity: "7", source: "voice", volume: 1.5 },
      { identity: "7", source: "screen", volume: 0 },
    ]);
  });

  it("limita a 0..200% e trata valor inválido como 100%", () => {
    const { rust, engine } = setup();
    engine.setParticipantVolume("7", "voice", 9);
    engine.setParticipantVolume("7", "voice", -1);
    engine.setParticipantVolume("7", "voice", Number.NaN);
    expect(rust.named("voice_set_participant_volume").map((c) => c.args?.volume)).toEqual([
      2, 0, 1,
    ]);
  });

  it("falha do Rust não derruba a interface", async () => {
    const { rust, engine } = setup();
    rust.on("voice_set_participant_volume", () => {
      throw new Error("x");
    });
    expect(() => engine.setParticipantVolume("7", "voice", 1)).not.toThrow();
    await tick();
  });
});

describe("NativeVoiceEngine: porta de ruído e medidor", () => {
  it("envia a sensibilidade de entrada junto com o processamento", async () => {
    const { rust, engine } = setup();
    await engine.setAudioProcessing({
      echoCancellation: true,
      noiseSuppression: "standard",
      autoGainControl: true,
      inputSensitivity: { mode: "manual", thresholdDb: -42 },
    });
    expect(rust.named("voice_set_audio_processing")[0]?.args).toMatchObject({
      inputSensitivity: { mode: "manual", thresholdDb: -42 },
    });
  });

  it("liga o medidor com um canal próprio (vale fora de chamada) e traduz input-level", async () => {
    const { rust, engine, seen } = setup();
    await engine.setInputLevelMonitor(true);
    const call = rust.named("voice_set_input_level_monitor")[0];
    expect(call?.args).toMatchObject({ enabled: true });
    expect(call?.args?.events).toBeDefined();
    // sem sala: o canal da sala nem existe, o do medidor é o único
    expect(rust.channels).toHaveLength(1);
    rust.emit({ type: "input-level", db: -37.5, gateOpen: true });
    expect(seen["input-level"]).toEqual([{ db: -37.5, gateOpen: true }]);
    // desligar não cria outro canal
    await engine.setInputLevelMonitor(false);
    expect(rust.named("voice_set_input_level_monitor")[1]?.args).toEqual({ enabled: false });
    expect(rust.channels).toHaveLength(1);
  });

  it("medição só da chamada (callOnly) usa o mesmo canal e avisa o Rust para não abrir prévia", async () => {
    const { rust, engine } = setup();
    await engine.setInputLevelMonitor(true, { callOnly: true });
    const call = rust.named("voice_set_input_level_monitor")[0];
    expect(call?.args).toMatchObject({ enabled: true, callOnly: true });
    await engine.setInputLevelMonitor(false, { callOnly: true });
    expect(rust.named("voice_set_input_level_monitor")[1]?.args).toEqual({
      enabled: false,
      callOnly: true,
    });
  });

  it("prepara o microfone em paralelo (dispositivo salvo primeiro) e o publica depois de conectar", async () => {
    localStorage.setItem("spook:voice-devices", JSON.stringify({ audioinput: "mic9" }));
    const { rust, engine } = setup();
    engine.prepareMicrophone();
    await engine.connect(params);
    await engine.setMicrophoneEnabled(true);
    const order = rust.calls.map((c) => c.cmd);
    expect(order.indexOf("voice_set_device")).toBeLessThan(
      order.indexOf("voice_prepare_microphone"),
    );
    expect(order.indexOf("voice_prepare_microphone")).toBeLessThan(
      order.indexOf("voice_set_microphone"),
    );
    expect(rust.named("voice_set_device")[0]?.args).toEqual({ kind: "audioinput", id: "mic9" });
    localStorage.clear();
  });

  it("descartar o preparo chama o Rust (solta o dispositivo)", async () => {
    const { rust, engine } = setup();
    engine.prepareMicrophone();
    engine.discardPreparedMicrophone();
    await new Promise((r) => setTimeout(r, 0));
    expect(rust.named("voice_discard_prepared_microphone")).toHaveLength(1);
  });

  it("o mesmo canal serve ao medidor e ao teste, e continua valendo depois de entrar na chamada", async () => {
    const { rust, engine, seen } = setup();
    await engine.setInputLevelMonitor(true);
    await engine.connect(params);
    expect(rust.channels).toHaveLength(2);
    rust.emit({ type: "input-level", db: -20, gateOpen: false }, 0);
    expect(seen["input-level"]).toEqual([{ db: -20, gateOpen: false }]);
    await engine.disconnect();
    rust.emit({ type: "input-level", db: -21, gateOpen: false }, 0);
    expect(seen["input-level"]).toHaveLength(2);
  });

  it("erro do Rust ao abrir o microfone vira VoiceMediaError", async () => {
    const { rust, engine } = setup();
    rust.on("voice_set_input_level_monitor", () => {
      throw { kind: "media", code: "permission-denied", device: "microphone", message: "Libere." };
    });
    const e = await engine.setInputLevelMonitor(true).catch((x) => x);
    expect(e).toBeInstanceOf(VoiceMediaError);
    expect(e.code).toBe("permission-denied");
  });
});

describe("NativeVoiceEngine: teste de microfone", () => {
  it("inicia pelo Rust e traduz as fases", async () => {
    const { rust, engine, seen } = setup();
    await engine.startMicTest();
    expect(rust.named("voice_start_mic_test")).toHaveLength(1);
    rust.emit({ type: "mic-test", phase: "requesting" });
    rust.emit({ type: "mic-test", phase: "recording", remainingMs: 4000 });
    rust.emit({ type: "mic-test", phase: "playing", remainingMs: 2000 });
    rust.emit({ type: "mic-test", phase: "done" });
    rust.emit({ type: "mic-test", phase: "error", error: "not-found" });
    expect(seen["mic-test"]).toEqual([
      { phase: "requesting" },
      { phase: "recording", remainingMs: 4000 },
      { phase: "playing", remainingMs: 2000 },
      { phase: "done" },
      { phase: "error", error: "not-found" },
    ]);
  });

  it("recusa com o microfone aberto na chamada: erro tipado vira evento mic-test in-use", async () => {
    const { rust, engine, seen } = setup();
    rust.on("voice_start_mic_test", () => {
      throw { kind: "media", code: "in-use", device: "microphone", message: "Em uso." };
    });
    await engine.startMicTest();
    expect(seen["mic-test"]).toEqual([{ phase: "error", error: "in-use" }]);
  });

  it("cancelar chama o Rust e nunca lança", async () => {
    const { rust, engine } = setup();
    rust.on("voice_cancel_mic_test", () => {
      throw new Error("x");
    });
    expect(() => engine.cancelMicTest()).not.toThrow();
    await tick();
    expect(rust.named("voice_cancel_mic_test")).toHaveLength(1);
  });
});

describe("NativeVoiceEngine: qualidade da tela", () => {
  it("envia a qualidade escolhida junto com a fonte", async () => {
    const { rust, engine } = setup();
    await engine.connect(params);
    const quality = { height: 1440, fps: 30, priority: "detail", maxBitrateKbps: 6000 } as const;
    await engine.setScreenShareEnabled(true, { quality });
    expect(rust.named("voice_set_screen_share")[0]?.args).toEqual({
      on: true,
      options: { sourceId: "display:1", audio: false, quality },
    });
  });

  it("sem qualidade, o Rust usa o padrão (o campo nem vai)", async () => {
    const { rust, engine } = setup();
    await engine.connect(params);
    await engine.setScreenShareEnabled(true);
    expect(rust.named("voice_set_screen_share")[0]?.args).toEqual({
      on: true,
      options: { sourceId: "display:1", audio: false },
    });
  });
});

describe("NativeVoiceEngine: captura preta e estatísticas", () => {
  it("repassa o aviso de captura preta do Rust", async () => {
    const { rust, engine } = setup();
    const seen: boolean[] = [];
    engine.on("screen-black", ({ black }) => seen.push(black));
    await engine.connect(params);
    rust.emit({ type: "screen-black", black: true });
    rust.emit({ type: "screen-black", black: false });
    expect(seen).toEqual([true, false]);
  });

  it("abrir os Ajustes de gravação de tela chama o comando do Rust", async () => {
    const { rust, engine } = setup();
    engine.openScreenCaptureSettings();
    await new Promise((r) => setTimeout(r, 0));
    expect(rust.named("app_open_screen_recording_settings")).toHaveLength(1);
  });

  it("estatísticas: sem quadros ainda tudo é desconhecido (nada de zeros inventados)", async () => {
    const { rust, engine, seen } = setup();
    await engine.connect(params);
    rust.emit({
      type: "video-track-added",
      id: "TR_1",
      identity: "7",
      kind: "screen",
      local: false,
    });
    const track = seen["video-track-added"]?.[0] as VideoTrackInfo;
    const s = await track.source.stats?.();
    expect(s).toMatchObject({
      role: "receive",
      width: null,
      height: null,
      fps: null,
      bitrateKbps: null,
      codec: "jpeg (app)",
    });
    rust.emit({
      type: "video-track-added",
      id: "local:screen",
      identity: "1",
      kind: "screen",
      local: true,
    });
    const mine = seen["video-track-added"]?.[1] as VideoTrackInfo;
    expect((await mine.source.stats?.())?.role).toBe("send");
  });
});
