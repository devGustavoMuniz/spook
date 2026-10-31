import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeVoiceEngine } from "@/test/fake-voice-engine";
import { type Backend, makeBackend, server } from "@/test/server";
import {
  joinVoice,
  leaveCall,
  leaveOnPageHide,
  REJOIN_DELAYS_MS,
  reconcileVoiceSnapshot,
  reconcileVoiceUpdate,
  resetVoiceController,
  toggleCamera,
  toggleDeafen,
  toggleMute,
  toggleScreenShare,
} from "./controller";
import { VoiceConnectError, VoiceMediaError } from "./engine";
import { setVoiceEngineFactory } from "./engine-provider";
import { useVoiceStatesStore, useVoiceStore } from "./store";

const toasts = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));

const ME = "1";
const A = { channelId: "c1", guildId: "g1", channelName: "Geral", canSpeak: true };
const B = { channelId: "c2", guildId: "g1", channelName: "Estudos", canSpeak: true };
const vs = (user: string, ch: string | null, x = {}) => ({
  guild_id: ch ? "g1" : null,
  channel_id: ch,
  user_id: user,
  self_mute: false,
  self_deaf: false,
  self_video: false,
  self_screen: false,
  ...x,
});

let fake: FakeVoiceEngine;
let backend: Backend;
const s = () => useVoiceStore.getState();

beforeEach(() => {
  fake = new FakeVoiceEngine();
  setVoiceEngineFactory(() => fake);
  resetVoiceController();
  useVoiceStatesStore.getState().reset();
  backend = makeBackend({ signedIn: true });
  server.use(...backend.handlers);
  toasts.error.mockClear();
  toasts.info.mockClear();
  localStorage.clear();
  REJOIN_DELAYS_MS.splice(0, REJOIN_DELAYS_MS.length, 0, 0, 0);
});

/** Entra e já confirma pelo gateway (webhook de entrada). */
async function joined(t = A) {
  expect(await joinVoice(t)).toBe(true);
  reconcileVoiceUpdate(ME, vs(ME, t.channelId));
}

describe("entrar", () => {
  it("pede o token do canal, conecta com url/token e liga o microfone", async () => {
    expect(await joinVoice(A)).toBe(true);
    expect(backend.state.voice.tokensFor).toEqual(["c1"]);
    expect(fake.connects).toEqual([{ url: "ws://livekit.test:7880", token: "token-c1-1" }]);
    expect(fake.mic).toBe(true);
    expect(s()).toMatchObject({ status: "connected", channelId: "c1", channelName: "Geral" });
    expect(backend.state.voice.stateBodies).toEqual([]); // nada a sincronizar: servidor começa sem mudo
  });

  it("sem SPEAK não abre o microfone (só ouve)", async () => {
    await joinVoice({ ...A, canSpeak: false });
    expect(fake.mic).toBe(false);
    expect(fake.calls).not.toContain("mic:true");
  });

  it("aplica os dispositivos salvos ao conectar", async () => {
    localStorage.setItem("spook:voice-devices", JSON.stringify({ audioinput: "mic9" }));
    await joinVoice(A);
    expect(fake.setDevices).toEqual([["audioinput", "mic9"]]);
  });

  it("trocar de canal desconecta a sala antiga antes de pedir o novo token", async () => {
    await joined(A);
    await joinVoice(B);
    expect(fake.calls.filter((c) => c === "connect" || c === "disconnect")).toEqual([
      "connect",
      "disconnect",
      "connect",
    ]);
    expect(backend.state.voice.tokensFor).toEqual(["c1", "c2"]);
    expect(s()).toMatchObject({ channelId: "c2", status: "connected", confirmed: false });
  });

  it("entrar no canal em que já está não faz nada", async () => {
    await joined(A);
    await joinVoice(A);
    expect(backend.state.voice.tokensFor).toEqual(["c1"]);
  });

  it.each([
    [403, "Você não tem permissão para entrar neste canal de voz."],
    [404, "Este canal de voz não está disponível para você."],
    [422, "Só é possível entrar em canais de voz e em conversas privadas."],
    [503, "A voz está indisponível no momento. Tente novamente mais tarde."],
  ])("token %i vira aviso em pt-br e não conecta", async (status, msg) => {
    backend.state.voice.tokenError = { status, detail: "x" };
    expect(await joinVoice(A)).toBe(false);
    expect(toasts.error).toHaveBeenCalledWith(msg);
    expect(s().status).toBe("idle");
    expect(fake.connects).toEqual([]);
  });

  it("token recusado (vencido) pede outro uma vez", async () => {
    fake.failConnectOnce = new VoiceConnectError("token-rejected");
    expect(await joinVoice(A)).toBe(true);
    expect(backend.state.voice.tokensFor).toHaveLength(2);
    expect(s().status).toBe("connected");
  });

  it("falha de conexão avisa e volta a fora da voz", async () => {
    fake.failConnect = new VoiceConnectError("unreachable");
    expect(await joinVoice(A)).toBe(false);
    expect(toasts.error).toHaveBeenCalledWith(expect.stringContaining("Não foi possível conectar"));
    expect(s().status).toBe("idle");
  });

  it("microfone negado pelo navegador: entra mudo, explica e avisa o servidor", async () => {
    fake.failMic = new VoiceMediaError("permission-denied", "microphone");
    await joinVoice(A);
    expect(s()).toMatchObject({ status: "connected", selfMute: true });
    expect(toasts.error).toHaveBeenCalledWith(expect.stringContaining("bloqueou o microfone"));
    expect(backend.state.voice.stateBodies).toEqual([{ self_mute: true, self_deaf: false }]);
  });
});

describe("mudo e surdo", () => {
  it("mudo desliga o microfone e avisa o servidor; de novo, religa", async () => {
    await joined();
    await toggleMute();
    expect(fake.mic).toBe(false);
    expect(s().selfMute).toBe(true);
    await toggleMute();
    expect(fake.mic).toBe(true);
    expect(backend.state.voice.stateBodies).toEqual([
      { self_mute: true, self_deaf: false },
      { self_mute: false, self_deaf: false },
    ]);
  });

  it("ensurdecer silencia o áudio remoto e também marca mudo; voltar restaura o mudo anterior", async () => {
    await joined();
    await toggleDeafen();
    expect(fake.deafened).toBe(true);
    expect(fake.mic).toBe(false);
    expect(s()).toMatchObject({ selfDeaf: true, selfMute: true });
    await toggleDeafen();
    expect(fake.deafened).toBe(false);
    expect(fake.mic).toBe(true);
    expect(s()).toMatchObject({ selfDeaf: false, selfMute: false });
    expect(backend.state.voice.stateBodies.at(-1)).toEqual({ self_mute: false, self_deaf: false });
  });

  it("quem já estava mudo continua mudo ao voltar a ouvir", async () => {
    await joined();
    await toggleMute();
    await toggleDeafen();
    await toggleDeafen();
    expect(s()).toMatchObject({ selfDeaf: false, selfMute: true });
    expect(fake.mic).toBe(false);
  });

  it("desmutar ensurdecido também volta a ouvir", async () => {
    await joined();
    await toggleDeafen();
    await toggleMute();
    expect(s()).toMatchObject({ selfDeaf: false, selfMute: false });
    expect(fake.deafened).toBe(false);
    expect(fake.mic).toBe(true);
  });

  it("mudo/surdo acompanham a troca de canal e são enviados ao novo canal", async () => {
    await joined(A);
    await toggleMute();
    backend.state.voice.stateBodies.length = 0;
    await joinVoice(B);
    expect(fake.mic).toBe(false);
    expect(backend.state.voice.stateBodies).toEqual([{ self_mute: true, self_deaf: false }]);
  });

  it("409 do PATCH (ainda sem webhook) não derruba nada", async () => {
    backend.state.voice.stateStatus = 409;
    await joined();
    await toggleMute();
    expect(s()).toMatchObject({ status: "connected", selfMute: true });
    expect(toasts.error).not.toHaveBeenCalled();
  });
});

describe("câmera e tela", () => {
  it("liga e desliga a câmera; a tela pede o áudio do sistema", async () => {
    await joined();
    await toggleCamera();
    await toggleScreenShare();
    expect(fake.camera).toBe(true);
    expect(fake.screen).toBe(true);
    expect(fake.calls).toContain("screen:true:audio");
    expect(s()).toMatchObject({ camera: true, screen: true });
    await toggleCamera();
    expect(s().camera).toBe(false);
  });

  it("seleção de tela cancelada: aviso amigável e nada fica ligado", async () => {
    await joined();
    fake.failScreen = new VoiceMediaError("cancelled", "screen");
    await toggleScreenShare();
    expect(toasts.error).toHaveBeenCalledWith("Compartilhamento de tela cancelado.");
    expect(s().screen).toBe(false);
  });

  it("câmera negada pelo navegador", async () => {
    await joined();
    fake.failCamera = new VoiceMediaError("permission-denied", "camera");
    await toggleCamera();
    expect(toasts.error).toHaveBeenCalledWith(expect.stringContaining("bloqueou a câmera"));
    expect(s().camera).toBe(false);
  });

  it("parar a tela pela barra do navegador atualiza o estado (evento da engine)", async () => {
    await joined();
    await toggleScreenShare();
    fake.fire("local-media", { microphone: true, camera: false, screenShare: false });
    expect(s().screen).toBe(false);
  });
});

describe("eventos da engine", () => {
  it("quem fala, faixas de vídeo, qualidade e áudio bloqueado", async () => {
    await joined();
    fake.fire("speakers-changed", { identities: ["2"] });
    expect(s().speaking.has("2")).toBe(true);
    fake.videoTrack("t1", "2", "screen");
    expect(s().videoTracks.map((t) => t.id)).toEqual(["t1"]);
    fake.fire("video-track-removed", { id: "t1" });
    expect(s().videoTracks).toEqual([]);
    fake.fire("link-quality", { quality: "poor" });
    expect(s().quality).toBe("poor");
    fake.fire("audio-blocked", { blocked: true });
    expect(s().audioBlocked).toBe(true);
  });

  it("reconexão da lib reflete no status", async () => {
    await joined();
    fake.fire("connection-state", { state: "reconnecting" });
    expect(s().status).toBe("reconnecting");
    fake.fire("connection-state", { state: "connected" });
    expect(s().status).toBe("connected");
  });
});

describe("sair e quedas", () => {
  it("sair desconecta, avisa o servidor (idempotente) e preserva mudo", async () => {
    await joined();
    await toggleMute();
    await leaveCall();
    expect(fake.state).toBe("disconnected");
    expect(backend.state.voice.leaves).toBe(1);
    expect(s()).toMatchObject({ status: "idle", channelId: null, selfMute: true });
    await leaveCall();
    expect(backend.state.voice.leaves).toBe(1);
  });

  it("desconexão forçada pelo servidor limpa o estado e avisa", async () => {
    await joined();
    fake.drop("removed");
    expect(s().status).toBe("idle");
    expect(toasts.info).toHaveBeenCalledWith("Você foi desconectado da chamada de voz.");
  });

  it("queda de rede que a lib não resolveu: reentra com um token novo", async () => {
    await joined();
    fake.drop("network");
    await vi.waitFor(() => expect(backend.state.voice.tokensFor).toHaveLength(2));
    await vi.waitFor(() => expect(s().status).toBe("connected"));
    expect(fake.connects[1]?.token).toBe("token-c1-2");
  });

  it("sem conseguir reentrar depois das tentativas, desiste e avisa", async () => {
    await joined();
    fake.failConnect = new VoiceConnectError("unreachable");
    fake.drop("network");
    await vi.waitFor(() => expect(s().status).toBe("idle"));
    expect(toasts.info).toHaveBeenCalledWith("A conexão de voz foi perdida.");
  });

  it("fechar a aba desconecta e manda o POST de saída com keepalive", async () => {
    await joined();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));
    leaveOnPageHide();
    expect(fake.state).toBe("disconnected");
    expect(spy).toHaveBeenCalledWith(
      "/api/voice/leave",
      expect.objectContaining({ method: "POST", keepalive: true }),
    );
    spy.mockRestore();
  });
});

describe("reconciliação com o gateway", () => {
  it("o evento de entrada confirma; a saída depois disso é remoção pelo servidor", async () => {
    await joinVoice(A);
    expect(s().confirmed).toBe(false);
    reconcileVoiceUpdate(ME, vs(ME, "c1"));
    expect(s().confirmed).toBe(true);
    reconcileVoiceUpdate(ME, vs(ME, null));
    expect(s().status).toBe("idle");
    expect(fake.state).toBe("disconnected");
    expect(toasts.info).toHaveBeenCalled();
  });

  it("troca de canal: a saída do canal antigo (antes da confirmação) é ignorada", async () => {
    await joined(A);
    await joinVoice(B);
    reconcileVoiceUpdate(ME, vs(ME, null)); // saída de A, chega depois do token de B
    expect(s()).toMatchObject({ status: "connected", channelId: "c2" });
    reconcileVoiceUpdate(ME, vs(ME, "c2"));
    expect(s().confirmed).toBe(true);
  });

  it("entrar em outro canal por outro dispositivo derruba a sala local", async () => {
    await joined(A);
    reconcileVoiceUpdate(ME, vs(ME, "c9"));
    expect(s().status).toBe("idle");
    expect(toasts.info).toHaveBeenCalledWith("Você entrou em outra chamada em outro dispositivo.");
  });

  it("estados de outras pessoas só atualizam o mapa", async () => {
    await joined();
    reconcileVoiceUpdate(ME, vs("2", "c1", { self_mute: true }));
    expect(useVoiceStatesStore.getState().byUser["2"]?.self_mute).toBe(true);
    expect(s().status).toBe("connected");
    reconcileVoiceUpdate(ME, vs("2", null));
    expect(useVoiceStatesStore.getState().byUser["2"]).toBeUndefined();
  });

  it("READY: o snapshot substitui o mapa; se eu não estou nele, a sala local acabou", async () => {
    await joined();
    reconcileVoiceUpdate(ME, vs("2", "c1"));
    reconcileVoiceSnapshot(ME, [vs("3", "c5")]);
    expect(Object.keys(useVoiceStatesStore.getState().byUser)).toEqual(["3"]);
    expect(s().status).toBe("idle");
  });

  it("READY que ainda me traz na sala só confirma", async () => {
    await joinVoice(A);
    reconcileVoiceSnapshot(ME, [vs(ME, "c1")]);
    expect(s()).toMatchObject({ status: "connected", confirmed: true });
  });

  it("READY antes da confirmação não derruba uma entrada em andamento", async () => {
    await joinVoice(A);
    reconcileVoiceSnapshot(ME, []);
    expect(s().status).toBe("connected");
  });
});
