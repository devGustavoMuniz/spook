import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePresenceStore } from "@/features/presence/store";
import { FakeVoiceEngine } from "@/test/fake-voice-engine";
import { makeBackend, server } from "@/test/server";
import { noteUserGesture, resetCallSounds } from "./call-sounds";
import {
  joinVoice,
  leaveCall,
  REJOIN_DELAYS_MS,
  readConnectionStats,
  reconcileVoiceUpdate,
  resetVoiceController,
  screenSourceSwapSupported,
  screenWatchSupported,
  setScreenWatching,
  swapScreenSource,
  toggleDeafen,
  toggleMute,
  watchStream,
} from "./controller";
import { VoiceMediaError } from "./engine";
import { setVoiceEngineFactory } from "./engine-provider";
import { useVoiceStatesStore, useVoiceStore } from "./store";

const toasts = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));

const played = vi.hoisted(() => ({ kinds: [] as string[] }));
vi.mock("./call-sounds", async (orig) => {
  const mod = await orig<typeof import("./call-sounds")>();
  return { ...mod, playCallSound: (k: string) => void played.kinds.push(k) };
});

const ME = "1";
const A = { channelId: "c1", guildId: "g1", channelName: "Geral", canSpeak: true };
const vs = (user: string, ch: string | null, x = {}) => ({
  guild_id: ch ? "g1" : null,
  channel_id: ch,
  user_id: user,
  self_mute: false,
  self_deaf: false,
  self_video: false,
  self_screen: false,
  screen_preview: false,
  ...x,
});

let fake: FakeVoiceEngine;
beforeEach(() => {
  fake = new FakeVoiceEngine();
  fake.audioCapabilities = {
    strongNoiseSuppression: false,
    screenWatch: true,
    screenSourceSwap: true,
    connectionStats: true,
  };
  setVoiceEngineFactory(() => fake);
  resetVoiceController();
  resetCallSounds();
  noteUserGesture();
  useVoiceStatesStore.getState().reset();
  usePresenceStore.getState().setMine(null, { status_pref: "online" });
  server.use(...makeBackend({ signedIn: true }).handlers);
  played.kinds.length = 0;
  localStorage.clear();
  REJOIN_DELAYS_MS.splice(0, REJOIN_DELAYS_MS.length, 0, 0, 0);
});

async function joined() {
  expect(await joinVoice(A)).toBe(true);
  reconcileVoiceUpdate(ME, vs(ME, "c1"));
}

describe("sons de evento", () => {
  it("toca ao entrar, silenciar, ativar, ensurdecer e sair", async () => {
    await joined();
    expect(played.kinds).toEqual(["join"]);
    await toggleMute();
    await toggleMute();
    await toggleDeafen();
    await toggleDeafen();
    await leaveCall();
    expect(played.kinds).toEqual(["join", "mute", "unmute", "deafen", "undeafen", "leave"]);
  });

  it("toca quando alguém entra, sai ou liga a transmissão na minha sala, nunca por mim", async () => {
    await joined();
    played.kinds.length = 0;
    reconcileVoiceUpdate(ME, vs("2", "c1"));
    reconcileVoiceUpdate(ME, vs("2", "c1", { self_screen: true }));
    reconcileVoiceUpdate(ME, vs("2", "c1", { self_screen: false }));
    reconcileVoiceUpdate(ME, vs("2", null));
    reconcileVoiceUpdate(ME, vs("3", "c9")); // outra sala: silêncio
    reconcileVoiceUpdate(ME, vs(ME, "c1", { self_mute: true })); // eu mesmo: silêncio
    expect(played.kinds).toEqual(["peer-join", "stream-start", "stream-end", "peer-leave"]);
  });

  it("fora da chamada os eventos dos outros não tocam", () => {
    reconcileVoiceUpdate(ME, vs("2", "c1"));
    expect(played.kinds).toEqual([]);
  });
});

describe("assistir telas", () => {
  it("declara a capacidade e começa sem assistir ninguém", async () => {
    await joined();
    expect(screenWatchSupported()).toBe(true);
    expect(useVoiceStore.getState().watching.size).toBe(0);
  });

  it("assistir e parar de assistir passam pela engine e pelo store", async () => {
    await joined();
    setScreenWatching("2", true);
    expect([...useVoiceStore.getState().watching]).toEqual(["2"]);
    setScreenWatching("2", false);
    expect(useVoiceStore.getState().watching.size).toBe(0);
    expect(fake.watches).toEqual([
      ["2", true],
      ["2", false],
    ]);
  });

  it("'Assistir transmissão' já assina a tela e, ao reconectar, a escolha é reaplicada", async () => {
    await joined();
    await watchStream(A, "5");
    expect(fake.watches).toContainEqual(["5", true]);
    fake.watches.length = 0;
    fake.drop("network");
    await vi.waitFor(() => expect(fake.watches).toContainEqual(["5", true]));
  });

  it("assistir antes de entrar na sala é reaplicado quando conecta; sair zera", async () => {
    await watchStream(A, "5");
    expect(fake.watches).toContainEqual(["5", true]);
    await leaveCall();
    expect(useVoiceStore.getState().watching.size).toBe(0);
  });

  it("engine sem a capacidade (desktop) não anuncia suporte", async () => {
    fake.audioCapabilities = { strongNoiseSuppression: false };
    await joined();
    expect(screenWatchSupported()).toBe(false);
    expect(screenSourceSwapSupported()).toBe(false);
  });
});

describe("trocar a fonte da tela", () => {
  it("só troca com a tela compartilhada e usa a preferência de áudio", async () => {
    await joined();
    await swapScreenSource();
    expect(fake.swaps).toHaveLength(0);
    useVoiceStore.getState().patch({ screen: true });
    await swapScreenSource();
    expect(fake.swaps).toEqual([{ audio: false }]);
  });

  it("cancelar o seletor não mostra erro; outra falha mostra", async () => {
    await joined();
    useVoiceStore.getState().patch({ screen: true });
    fake.failSwap = new VoiceMediaError("cancelled", "screen");
    await swapScreenSource();
    expect(toasts.error).not.toHaveBeenCalled();
    fake.failSwap = new VoiceMediaError("in-use", "screen");
    await swapScreenSource();
    expect(toasts.error).toHaveBeenCalled();
  });
});

describe("estatísticas de rede", () => {
  it("lê da engine só conectado", async () => {
    expect(await readConnectionStats()).toBeNull();
    await joined();
    fake.stats = { rttMs: 40, lossPct: 0, jitterMs: 3 };
    expect(await readConnectionStats()).toEqual({ rttMs: 40, lossPct: 0, jitterMs: 3 });
  });
});
