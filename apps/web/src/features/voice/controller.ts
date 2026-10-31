// Orquestra a chamada: token (API) + engine (mídia) + store (estado) + avisos. Sem React: funções
// de módulo, para o gateway, a barra de controle e os botões de canal usarem o mesmo fluxo.
import {
  createVoiceToken,
  type VoiceStatePayload as GatewayVoiceState,
  isApiError,
  leaveVoice,
  updateVoiceState,
} from "@spook/shared";
import { toast } from "sonner";
import { voiceMessage } from "@/lib/app-errors";
import {
  loadAudioProcessing,
  loadDevicePrefs,
  loadScreenSharePrefs,
  saveAudioProcessing,
  saveDevicePref,
  saveScreenSharePrefs,
} from "./devices";
import {
  type AudioCapabilities,
  type AudioProcessingOptions,
  type AudioProcessingStatus,
  type DeviceKind,
  type DisconnectReason,
  type Unsubscribe,
  VoiceConnectError,
  type VoiceEngine,
} from "./engine";
import { createVoiceEngine } from "./engine-provider";
import { mediaMessage } from "./media-errors";
import { useAudioStatusStore, useVoiceStatesStore, useVoiceStore } from "./store";

export type JoinTarget = {
  channelId: string;
  /** `null` em DM. */
  guildId: string | null;
  channelName: string;
  /** Permissões na hora de entrar (a UI já as conhece); o servidor é quem decide o que o token permite. */
  canSpeak: boolean;
};

/** Esperas (ms) entre as tentativas de reentrar depois que a lib desistiu de reconectar. */
export const REJOIN_DELAYS_MS: number[] = [1000, 3000, 6000];

let engine: VoiceEngine | null = null;
let unsubs: Unsubscribe[] = [];
/** Cada entrada/saída incrementa; respostas de tentativas antigas são descartadas. */
let generation = 0;
let lastTarget: JoinTarget | null = null;
let rejoinTimer: ReturnType<typeof setTimeout> | undefined;

const session = () => useVoiceStore.getState();

function ensureEngine(): VoiceEngine {
  if (engine) return engine;
  const e = createVoiceEngine();
  engine = e;
  unsubs = [
    e.on("speakers-changed", ({ identities }) =>
      session().patch({ speaking: new Set(identities) }),
    ),
    e.on("video-track-added", (t) => session().addTrack(t)),
    e.on("video-track-removed", ({ id }) => session().removeTrack(id)),
    e.on("connection-state", ({ state }) => {
      const s = session();
      if (s.status === "idle" || s.status === "connecting") return;
      if (state === "connected" || state === "reconnecting") s.patch({ status: state });
    }),
    e.on("link-quality", ({ quality }) => session().patch({ quality })),
    e.on("local-media", (m) => {
      if (session().status === "idle") return;
      session().patch({ camera: m.camera, screen: m.screenShare });
    }),
    e.on("audio-blocked", ({ blocked }) => session().patch({ audioBlocked: blocked })),
    e.on("audio-processing-status", onAudioProcessingStatus),
    e.on("disconnected", ({ reason }) => onDisconnected(reason)),
  ];
  return e;
}

/**
 * A engine informou o estado do processamento do microfone. Se a IA foi rebaixada para "Padrão" (sem suporte,
 * download que falhou, processamento lento), grava o nível novo (para não tentar e falhar a cada chamada) e avisa.
 */
function onAudioProcessingStatus(status: AudioProcessingStatus) {
  useAudioStatusStore.getState().set(status);
  if (status.state !== "degraded") return;
  const saved = loadAudioProcessing();
  if (saved.noiseSuppression === "strong")
    saveAudioProcessing({ ...saved, noiseSuppression: status.level });
  toast.warning(
    status.reason ?? "A redução de ruído por IA foi desativada. Usando o filtro Padrão.",
  );
}

/** Só para testes: solta a engine, os timers e o estado. */
export function resetVoiceController() {
  useAudioStatusStore.getState().set(null);
  generation++;
  clearTimeout(rejoinTimer);
  for (const u of unsubs) u();
  unsubs = [];
  engine = null;
  lastTarget = null;
  useVoiceStore.getState().reset();
}

async function fetchToken(channelId: string) {
  return createVoiceToken(channelId);
}

/** Entra (ou troca de canal). Devolve `true` se conectou. Erros viram aviso; nunca lança. */
export async function joinVoice(target: JoinTarget): Promise<boolean> {
  const s = session();
  if (s.channelId === target.channelId && s.status !== "idle") return true;
  const gen = ++generation;
  clearTimeout(rejoinTimer);
  lastTarget = target;
  let eng: VoiceEngine;
  try {
    eng = ensureEngine();
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Voz indisponível neste aplicativo.");
    return false;
  }
  // Pedir o token de outro canal já tira o usuário do anterior no servidor; o cliente sai da sala antiga.
  if (s.status !== "idle") await eng.disconnect();
  session().begin(target);
  const ok = await connectWithToken(eng, target, gen);
  if (gen !== generation) return false;
  if (!ok) {
    session().clear();
    return false;
  }
  await afterConnect(eng, target, gen);
  return gen === generation;
}

/** Token + conexão; com token recusado (vencido) pede outro uma vez. */
async function connectWithToken(eng: VoiceEngine, target: JoinTarget, gen: number) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let token: Awaited<ReturnType<typeof fetchToken>>;
    try {
      token = await fetchToken(target.channelId);
    } catch (err) {
      if (gen === generation) toast.error(voiceMessage(err));
      return false;
    }
    if (gen !== generation) return false;
    try {
      await eng.connect({ url: token.url, token: token.token });
      return gen === generation;
    } catch (err) {
      if (gen !== generation) return false;
      if (err instanceof VoiceConnectError && err.code === "token-rejected" && attempt === 0)
        continue;
      toast.error("Não foi possível conectar à chamada de voz. Verifique sua conexão.");
      return false;
    }
  }
  return false;
}

async function afterConnect(eng: VoiceEngine, target: JoinTarget, gen: number) {
  session().patch({ status: "connected" });
  const prefs = loadDevicePrefs();
  for (const kind of Object.keys(prefs) as DeviceKind[]) {
    const id = prefs[kind];
    if (id) await eng.setDevice(kind, id).catch(() => {});
  }
  await eng.setAudioProcessing?.(loadAudioProcessing()).catch(() => {});
  const { selfMute, selfDeaf } = session();
  eng.setDeafened(selfDeaf);
  if (!selfMute && !selfDeaf && target.canSpeak) {
    try {
      await eng.setMicrophoneEnabled(true);
    } catch (err) {
      if (gen !== generation) return;
      // Sem microfone: entra mudo (como ouvinte) e explica.
      toast.error(mediaMessage(err));
      session().patch({ selfMute: true, muteBeforeDeaf: true });
    }
  }
  if (gen !== generation) return;
  // O servidor começa sem mudo/surdo: só avisa quando a intenção local difere (ex.: veio mudo da chamada anterior).
  if (session().selfMute || session().selfDeaf) await syncState();
}

/** Mute/deafen no servidor. Entre o token e o webhook de entrada ainda vale; falha só é registrada. */
async function syncState() {
  const { selfMute, selfDeaf } = session();
  try {
    await updateVoiceState({ self_mute: selfMute, self_deaf: selfDeaf });
  } catch (err) {
    if (!(isApiError(err) && err.status === 409))
      console.warn("voz: falha ao sincronizar estado", err);
  }
}
/** Sai da chamada (botão "Sair"). */
export async function leaveCall() {
  if (session().status === "idle") return;
  generation++;
  clearTimeout(rejoinTimer);
  const eng = engine;
  session().clear();
  useAudioStatusStore.getState().set(null);
  await eng?.disconnect();
  try {
    await leaveVoice();
  } catch (err) {
    console.warn("voz: falha ao avisar a saída", err);
  }
}

export async function toggleMute() {
  const s = session();
  if (s.status === "idle") return;
  const mute = !s.selfMute;
  // Desmutar ensurdecido também volta a ouvir (como no Discord).
  const undeaf = !mute && s.selfDeaf;
  session().patch({
    selfMute: mute,
    muteBeforeDeaf: mute,
    ...(undeaf ? { selfDeaf: false } : {}),
  });
  if (undeaf) engine?.setDeafened(false);
  await applyMic(!mute);
  await syncState();
}

export async function toggleDeafen() {
  const s = session();
  if (s.status === "idle") return;
  if (!s.selfDeaf) {
    session().patch({ selfDeaf: true, selfMute: true, muteBeforeDeaf: s.selfMute });
    engine?.setDeafened(true);
    await applyMic(false);
  } else {
    const mute = s.muteBeforeDeaf;
    session().patch({ selfDeaf: false, selfMute: mute });
    engine?.setDeafened(false);
    await applyMic(!mute);
  }
  await syncState();
}

async function applyMic(on: boolean) {
  if (!engine) return;
  try {
    await engine.setMicrophoneEnabled(on);
  } catch (err) {
    if (!on) return;
    toast.error(mediaMessage(err));
    session().patch({ selfMute: true, muteBeforeDeaf: true });
  }
}

export async function toggleCamera() {
  if (session().status === "idle" || !engine) return;
  const on = !session().camera;
  try {
    await engine.setCameraEnabled(on);
    session().patch({ camera: on });
  } catch (err) {
    toast.error(mediaMessage(err));
  }
}

/**
 * Liga/desliga o compartilhamento de tela. O áudio do compartilhamento é DESLIGADO por padrão: ele costuma
 * carregar a voz dos outros da chamada e eles se ouviriam de volta (eco). Quem decide é o diálogo de
 * compartilhar (`audio`), que também guarda a escolha.
 */
export async function toggleScreenShare(opts?: { audio?: boolean }) {
  if (session().status === "idle" || !engine) return;
  const on = !session().screen;
  const audio = on && (opts?.audio ?? loadScreenSharePrefs().audio);
  if (on && opts?.audio !== undefined) saveScreenSharePrefs({ audio: opts.audio });
  try {
    await engine.setScreenShareEnabled(on, { audio });
    session().patch({ screen: on });
  } catch (err) {
    toast.error(mediaMessage(err));
  }
}

export async function resumeAudio() {
  await engine?.resumeAudio().catch(() => {});
}

/** Troca de dispositivo (diálogo): persiste e, em chamada, aplica na hora. */
export async function chooseDevice(kind: DeviceKind, deviceId: string) {
  saveDevicePref(kind, deviceId || undefined);
  try {
    await engine?.setDevice(kind, deviceId || "default");
  } catch (err) {
    toast.error(mediaMessage(err));
  }
}

/** A engine atual processa o áudio (eco/ruído/ganho)? Web (constraints + IA) e desktop (APM nativo). */
export function supportsAudioProcessing(): boolean {
  try {
    return typeof ensureEngine().setAudioProcessing === "function";
  } catch {
    return false;
  }
}

/** Interruptores de eco/ruído/ganho (diálogo de dispositivos): persiste e, em chamada, aplica na hora. */
export async function chooseAudioProcessing(options: AudioProcessingOptions) {
  saveAudioProcessing(options);
  try {
    await engine?.setAudioProcessing?.(options);
  } catch (err) {
    toast.error(mediaMessage(err));
  }
}

/** O que a engine atual sabe fazer com o áudio (a interface se adapta a isto). */
export function audioCapabilities(): AudioCapabilities {
  try {
    return ensureEngine().audioCapabilities ?? { strongNoiseSuppression: false };
  } catch {
    return { strongNoiseSuppression: false };
  }
}

export function listDevices(kind: DeviceKind) {
  try {
    return ensureEngine().listDevices(kind);
  } catch {
    return Promise.resolve([]);
  }
}

// ---- Desconexão que não pedimos ----

function onDisconnected(reason: DisconnectReason) {
  if (reason === "client" || session().status === "idle") return;
  if (reason === "removed") return forcedOut("Você foi desconectado da chamada de voz.");
  void rejoin(generation, 0);
}

/** A lib desistiu de reconectar (rede, token vencido ao reconectar): tenta entrar de novo com outro token. */
async function rejoin(gen: number, attempt: number) {
  const target = lastTarget;
  if (!target) return forcedOut("A conexão de voz foi perdida.");
  // O webhook de saída da sala velha chega como "saí": sem confirmação ele é ignorado até a nova entrada.
  session().patch({
    status: "reconnecting",
    speaking: new Set(),
    videoTracks: [],
    confirmed: false,
  });
  const delay = REJOIN_DELAYS_MS[attempt];
  if (delay === undefined) return forcedOut("A conexão de voz foi perdida.");
  await new Promise<void>((resolve) => {
    rejoinTimer = setTimeout(resolve, delay);
  });
  if (gen !== generation || !engine) return;
  const ok = await connectWithToken(engine, target, gen);
  if (gen !== generation) return;
  if (!ok) return void rejoin(gen, attempt + 1);
  await afterConnect(engine, target, gen);
}

/** O servidor (ou a rede, sem volta) nos tirou: limpa o estado local e avisa. */
function forcedOut(message: string) {
  generation++;
  clearTimeout(rejoinTimer);
  session().clear();
  useAudioStatusStore.getState().set(null);
  void engine?.disconnect();
  toast.info(message);
}

// ---- Reconciliação com o gateway ----

/**
 * VOICE_STATE_UPDATE de um usuário. Só o meu importa para a sessão local: ele confirma a entrada e,
 * se vier "saí" depois de confirmado, o servidor me tirou da sala (perdi CONNECT, canal excluído,
 * entrei em outro dispositivo…). Antes da confirmação (token pedido, webhook pendente) a saída do
 * canal ANTERIOR numa troca também chega assim e deve ser ignorada.
 */
export function reconcileVoiceUpdate(myId: string | null, u: GatewayVoiceState) {
  useVoiceStatesStore.getState().apply(u);
  if (!myId || u.user_id !== myId) return;
  const s = session();
  if (s.status === "idle") return;
  if (u.channel_id === s.channelId) {
    if (!s.confirmed) s.patch({ confirmed: true });
    return;
  }
  if (!s.confirmed) return;
  forcedOut(
    u.channel_id
      ? "Você entrou em outra chamada em outro dispositivo."
      : "Você foi desconectado da chamada de voz.",
  );
}

/** READY: o snapshot substitui o mapa e confere se a sala local ainda é a que o servidor conhece. */
export function reconcileVoiceSnapshot(myId: string | null, states: readonly GatewayVoiceState[]) {
  useVoiceStatesStore.getState().replaceAll(states);
  if (!myId) return;
  const s = session();
  if (s.status === "idle" || !s.channelId) return;
  const mine = states.find((x) => x.user_id === myId && x.channel_id);
  if (mine?.channel_id === s.channelId) {
    if (!s.confirmed) s.patch({ confirmed: true });
    return;
  }
  if (s.confirmed) forcedOut("Você foi desconectado da chamada de voz.");
}

/** Aba fechando: desconecta e avisa o servidor sem esperar (a requisição sobrevive à página). */
export function leaveOnPageHide() {
  if (session().status === "idle") return;
  void engine?.disconnect();
  try {
    void fetch("/api/voice/leave", { method: "POST", credentials: "same-origin", keepalive: true });
  } catch {
    // o servidor tira o usuário pelo webhook do LiveKit quando a conexão cai
  }
}

/** Área autenticada desmontada (sair da conta): solta a sala local; a sessão já não permite avisar o servidor. */
export function shutdownVoice() {
  generation++;
  clearTimeout(rejoinTimer);
  void engine?.disconnect();
  useVoiceStore.getState().reset();
  useVoiceStatesStore.getState().reset();
}
