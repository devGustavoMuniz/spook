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
import { playCallSound } from "./call-sounds";
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
  type ConnectionStats,
  type DeviceKind,
  type DisconnectReason,
  type ScreenShareQuality,
  type Unsubscribe,
  VoiceConnectError,
  type VoiceEngine,
  VoiceMediaError,
} from "./engine";
import { createVoiceEngine } from "./engine-provider";
import { mediaMessage } from "./media-errors";
import { effectiveVolume, personVolumeOf, useParticipantVolumeStore } from "./participant-volume";
import { startScreenPreview } from "./screen-preview";
import { loadScreenQuality, saveScreenQuality } from "./screen-quality";
import {
  useAudioStatusStore,
  useInputLevelStore,
  useMicTestStore,
  useVoiceAvailabilityStore,
  useVoiceStatesStore,
  useVoiceStore,
} from "./store";

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
/** Envio da prévia da minha tela (ver `syncScreenPreview`); `previewChannel` é o canal para o qual está ligado. */
let stopPreview: ((remote?: boolean) => void) | null = null;
let previewChannel: string | null = null;
let focusNonce = 0;
/** Um moderador mutou a minha voz (MUTE_MEMBERS): o microfone fica bloqueado até o servidor liberar. */
let serverMuted = false;

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
    e.on("participant-joined", ({ identity }) => applyPersonVolume(e, identity)),
    e.on("input-level", (l) => useInputLevelStore.getState().set(l)),
    e.on("mic-test", (s) => useMicTestStore.getState().set(s)),
    e.on("disconnected", ({ reason }) => onDisconnected(reason)),
    useVoiceStore.subscribe(syncScreenPreview),
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
  useInputLevelStore.getState().set(null);
  useMicTestStore.getState().set(null);
  generation++;
  clearTimeout(rejoinTimer);
  for (const u of unsubs) u();
  unsubs = [];
  stopScreenPreview(false);
  engine = null;
  lastTarget = null;
  useVoiceStore.getState().reset();
}

async function fetchToken(channelId: string) {
  return createVoiceToken(channelId);
}

/** Entra (ou troca de canal). Devolve `true` se conectou. Erros viram aviso; nunca lança. */
export async function joinVoice(
  target: JoinTarget,
  /** Token já emitido (ex.: pela resposta de "Atender"): usado na primeira tentativa em vez de pedir outro. */
  prefetched?: { url: string; token: string },
): Promise<boolean> {
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
  const ok = await connectWithToken(eng, target, gen, prefetched);
  if (gen !== generation) return false;
  if (!ok) {
    session().clear();
    return false;
  }
  await afterConnect(eng, target, gen);
  if (gen === generation) playCallSound("join");
  return gen === generation;
}

/** Token + conexão; com token recusado (vencido) pede outro uma vez. */
async function connectWithToken(
  eng: VoiceEngine,
  target: JoinTarget,
  gen: number,
  prefetched?: { url: string; token: string },
) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let token: { url: string; token: string };
    try {
      token = attempt === 0 && prefetched ? prefetched : await fetchToken(target.channelId);
    } catch (err) {
      if (gen === generation) {
        toast.error(voiceMessage(err));
        if (isApiError(err) && err.status === 503) useVoiceAvailabilityStore.getState().set(true);
      }
      return false;
    }
    if (gen !== generation) return false;
    try {
      await eng.connect({ url: token.url, token: token.token });
      useVoiceAvailabilityStore.getState().set(false);
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
  // Reaplica as telas que o usuário escolheu assistir (a engine começa sem assinar nenhuma).
  for (const id of session().watching) eng.setScreenWatching?.(id, true);
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
      reportMediaIssue(err);
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
  serverMuted = false;
  const eng = engine;
  session().clear();
  useAudioStatusStore.getState().set(null);
  playCallSound("leave");
  await eng?.disconnect();
  try {
    await leaveVoice();
  } catch (err) {
    console.warn("voz: falha ao avisar a saída", err);
  }
}

export async function toggleMute() {
  const s = session();
  const mute = !s.selfMute;
  if (!mute && serverMuted && s.status !== "idle") {
    toast.error("Um moderador mutou você nesta chamada. Peça para liberarem o seu microfone.");
    return;
  }
  if (s.status === "idle") {
    // Fora da chamada só guarda a preferência (vale ao entrar; `clear` a preserva).
    s.patch({
      selfMute: mute,
      muteBeforeDeaf: mute,
      ...(!mute && s.selfDeaf ? { selfDeaf: false } : {}),
    });
    return;
  }
  // Desmutar ensurdecido também volta a ouvir (como no Discord).
  const undeaf = !mute && s.selfDeaf;
  session().patch({
    selfMute: mute,
    muteBeforeDeaf: mute,
    ...(undeaf ? { selfDeaf: false } : {}),
  });
  if (undeaf) engine?.setDeafened(false);
  playCallSound(mute ? "mute" : "unmute");
  await applyMic(!mute);
  await syncState();
}

export async function toggleDeafen() {
  const s = session();
  if (s.status === "idle") {
    if (!s.selfDeaf) s.patch({ selfDeaf: true, selfMute: true, muteBeforeDeaf: s.selfMute });
    else s.patch({ selfDeaf: false, selfMute: s.muteBeforeDeaf });
    return;
  }
  if (!s.selfDeaf) {
    session().patch({ selfDeaf: true, selfMute: true, muteBeforeDeaf: s.selfMute });
    playCallSound("deafen");
    engine?.setDeafened(true);
    await applyMic(false);
  } else {
    const mute = s.muteBeforeDeaf;
    session().patch({ selfDeaf: false, selfMute: mute });
    playCallSound("undeafen");
    engine?.setDeafened(false);
    await applyMic(!mute);
  }
  await syncState();
}

/** Aviso passageiro (toast) e persistente (faixa no palco) para falha de microfone/câmera/tela. */
function reportMediaIssue(err: unknown) {
  const message = mediaMessage(err);
  toast.error(message);
  session().patch({ mediaIssue: message });
}

async function applyMic(on: boolean) {
  if (!engine) return;
  if (on && serverMuted) {
    // O servidor não deixa publicar: continua mudo em vez de tentar e falhar.
    session().patch({ selfMute: true, muteBeforeDeaf: true });
    return;
  }
  try {
    await engine.setMicrophoneEnabled(on);
    if (on) session().patch({ mediaIssue: null });
  } catch (err) {
    if (!on) return;
    reportMediaIssue(err);
    session().patch({ selfMute: true, muteBeforeDeaf: true });
  }
}

export async function toggleCamera() {
  if (session().status === "idle" || !engine) return;
  const on = !session().camera;
  try {
    await engine.setCameraEnabled(on);
    session().patch({ camera: on, mediaIssue: null });
  } catch (err) {
    reportMediaIssue(err);
  }
}

/**
 * Liga/desliga o compartilhamento de tela. O áudio do compartilhamento é DESLIGADO por padrão: ele costuma
 * carregar a voz dos outros da chamada e eles se ouviriam de volta (eco). Quem decide é o diálogo de
 * compartilhar (`audio`), que também guarda a escolha.
 */
export async function toggleScreenShare(opts?: {
  audio?: boolean;
  quality?: ScreenShareQuality;
  /** Enviar a prévia (miniatura) da tela ao canal; ausente = a última escolha (padrão: ligada). */
  preview?: boolean;
}) {
  if (session().status === "idle" || !engine) return;
  const on = !session().screen;
  const prefs = loadScreenSharePrefs();
  const audio = on && (opts?.audio ?? prefs.audio);
  if (on && (opts?.audio !== undefined || opts?.preview !== undefined))
    saveScreenSharePrefs({
      ...(opts.audio !== undefined ? { audio: opts.audio } : {}),
      ...(opts.preview !== undefined ? { preview: opts.preview } : {}),
    });
  // Só engines que conseguem capturar um quadro da tela enviam a prévia (o desktop declara `false`).
  const preview =
    on &&
    (opts?.preview ?? prefs.preview) &&
    engine.audioCapabilities?.screenSharePreview !== false;
  // Só engines que declaram a capacidade recebem a qualidade (o app desktop ainda não a aplica).
  const quality =
    on && engine.audioCapabilities?.screenShareQuality
      ? (opts?.quality ?? loadScreenQuality())
      : undefined;
  if (on && opts?.quality) saveScreenQuality(opts.quality);
  try {
    await engine.setScreenShareEnabled(on, quality ? { audio, quality } : { audio });
    session().patch({ screen: on, screenPreview: preview, mediaIssue: null });
  } catch (err) {
    reportMediaIssue(err);
  }
}

/** Liga/desliga o envio da prévia com a tela já compartilhada (desligar apaga a prévia no servidor). */
export function setScreenPreview(enabled: boolean) {
  const s = session();
  if (!s.screen || engine?.audioCapabilities?.screenSharePreview === false) return;
  s.patch({ screenPreview: enabled });
  saveScreenSharePrefs({ preview: enabled });
}

function stopScreenPreview(remote = true) {
  stopPreview?.(remote);
  stopPreview = null;
  previewChannel = null;
}

/** Mantém o envio da prévia em sincronia com o estado: só com a tela ligada, a opção ligada e a sala conectada. */
function syncScreenPreview() {
  const s = session();
  const channel = s.screen && s.screenPreview && s.status === "connected" ? s.channelId : null;
  if (channel === previewChannel) return;
  stopScreenPreview();
  if (!channel) return;
  previewChannel = channel;
  stopPreview = startScreenPreview(
    channel,
    () => session().videoTracks.find((t) => t.local && t.kind === "screen")?.source,
  );
}

/**
 * "Assistir transmissão": põe a tela de `userId` em foco no palco. Se não estou nesse canal, entra nele (o foco
 * espera a sala conectar e a tela chegar, até ~10 s). Devolve `false` se não deu para entrar.
 */
export async function watchStream(target: JoinTarget, userId: string): Promise<boolean> {
  session().patch({
    focusRequest: { userId, source: "screen", at: Date.now(), nonce: ++focusNonce },
  });
  setScreenWatching(userId, true);
  const s = session();
  if (s.channelId === target.channelId && s.status !== "idle") return true;
  return joinVoice(target);
}

/** A engine atual deixa escolher quais telas assistir? Sem isso ela assina todas (o app desktop). */
export function screenWatchSupported(): boolean {
  return engine?.audioCapabilities?.screenWatch === true;
}

/** Começa/para de assistir a tela de `userId` (assina/cancela a faixa; economiza banda). */
export function setScreenWatching(userId: string, on: boolean) {
  const cur = session().watching;
  if (cur.has(userId) !== on) {
    const next = new Set(cur);
    if (on) next.add(userId);
    else next.delete(userId);
    session().patch({ watching: next });
  }
  if (session().status === "connected") engine?.setScreenWatching?.(userId, on);
}

/** Troca a janela/tela que estou compartilhando, sem parar a transmissão. */
export async function swapScreenSource() {
  if (session().status === "idle" || !session().screen || !engine?.replaceScreenShareSource) return;
  try {
    await engine.replaceScreenShareSource({ audio: loadScreenSharePrefs().audio });
    session().patch({ mediaIssue: null });
  } catch (err) {
    // Cancelar o seletor mantém a fonte anterior: sem alarme.
    if (err instanceof VoiceMediaError && err.code === "cancelled") return;
    reportMediaIssue(err);
  }
}

/** A engine permite trocar a fonte da tela em curso? */
export function screenSourceSwapSupported(): boolean {
  return engine?.audioCapabilities?.screenSourceSwap === true;
}

/** Mede a rede agora (RTT, perda, jitter); `null` quando a engine não mede ou não há sala. */
export async function readConnectionStats(): Promise<ConnectionStats | null> {
  if (session().status !== "connected" || !engine?.getConnectionStats) return null;
  try {
    return await engine.getConnectionStats();
  } catch {
    return null;
  }
}

/** O pedido de foco foi atendido ou venceu. */
export function clearFocusRequest(nonce?: number) {
  const cur = session().focusRequest;
  if (cur && (nonce === undefined || cur.nonce === nonce)) session().patch({ focusRequest: null });
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

// ---- Volume por pessoa ----

/** Maior volume que a engine atual aceita (1 = 100%); `null` = a engine não ajusta volume por pessoa. */
export function participantVolumeMax(): number | null {
  return engine?.audioCapabilities?.participantVolume?.max ?? null;
}

/** Empurra para a engine o volume salvo dessa pessoa (voz e tela); sem ajuste salvo, não faz nada. */
function applyPersonVolume(eng: VoiceEngine, userId: string) {
  const max = eng.audioCapabilities?.participantVolume?.max;
  if (max === undefined || !eng.setParticipantVolume) return;
  const saved = useParticipantVolumeStore.getState().byUser[userId];
  if (!saved) return; // sem ajuste salvo: a engine já toca a 100%
  for (const source of ["voice", "screen"] as const)
    eng.setParticipantVolume(userId, source, effectiveVolume(saved, source, max));
}

/**
 * Ajusta o volume local de uma pessoa (voz, áudio da tela ou "silenciar só para mim"): persiste e aplica na hora.
 * O deafen é independente: ensurdecido continua tudo mudo, qualquer que seja o volume.
 */
export function setPersonVolume(
  userId: string,
  patch: Partial<{ voice: number; screen: number; muted: boolean }>,
) {
  useParticipantVolumeStore.getState().set(userId, patch);
  const max = engine?.audioCapabilities?.participantVolume?.max;
  if (!engine?.setParticipantVolume || max === undefined) return;
  const v = personVolumeOf(useParticipantVolumeStore.getState().byUser, userId);
  for (const source of ["voice", "screen"] as const)
    engine.setParticipantVolume(userId, source, effectiveVolume(v, source, max));
}

// ---- Medidor de nível, teste de microfone e sensibilidade ----

/**
 * Liga o medidor (evento `input-level`). Reaplica antes o processamento salvo, para a captura de teste fora
 * da chamada usar o mesmo nível de ruído, eco, ganho e porta que a chamada usará.
 */
export async function startInputMonitor(): Promise<void> {
  const eng = ensureEngine();
  if (!eng.setInputLevelMonitor) return;
  useInputLevelStore.getState().set(null);
  try {
    await eng.setAudioProcessing?.(loadAudioProcessing());
    await eng.setInputLevelMonitor(true);
  } catch (err) {
    toast.error(mediaMessage(err));
  }
}

export function stopInputMonitor() {
  void engine?.setInputLevelMonitor?.(false).catch(() => {});
  useInputLevelStore.getState().set(null);
}

/** Grava ~5 s e reproduz no alto-falante escolhido. O andamento sai no `useMicTestStore`. */
export async function runMicTest(): Promise<void> {
  const eng = ensureEngine();
  if (!eng.startMicTest) return;
  useMicTestStore.getState().set({ phase: "requesting" });
  await eng.setAudioProcessing?.(loadAudioProcessing()).catch(() => {});
  await eng.startMicTest().catch((err) => {
    useMicTestStore.getState().set({ phase: "error", error: "unknown" });
    console.warn("voz: falha no teste de microfone", err);
  });
}

export function cancelMicTest() {
  engine?.cancelMicTest?.();
}

/** O teste de gravação toca no alto-falante: com o microfone aberto na chamada, todos ouviriam. */
export function micTestBlockedByCall(): boolean {
  const s = session();
  return s.status !== "idle" && !s.selfMute;
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
  serverMuted = false;
  generation++;
  clearTimeout(rejoinTimer);
  session().clear();
  useAudioStatusStore.getState().set(null);
  playCallSound("leave");
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
  const before = useVoiceStatesStore.getState().byUser[u.user_id];
  useVoiceStatesStore.getState().apply(u);
  playPeerSounds(myId, before, u);
  if (!myId || u.user_id !== myId) return;
  const s = session();
  if (s.status === "idle") return;
  if (u.channel_id === s.channelId) {
    if (!s.confirmed) s.patch({ confirmed: true });
    syncServerMute(!!u.server_muted);
    return;
  }
  if (!s.confirmed) return;
  forcedOut(
    u.channel_id
      ? "Você entrou em outra chamada em outro dispositivo."
      : "Você foi desconectado da chamada de voz.",
  );
}

/** O servidor mutou (ou liberou) o MEU microfone: bloqueia/libera o botão, silencia a captura e avisa. */
function syncServerMute(muted: boolean) {
  if (muted === serverMuted) return;
  serverMuted = muted;
  if (muted) {
    session().patch({ selfMute: true, muteBeforeDeaf: true });
    void engine?.setMicrophoneEnabled(false).catch(() => {});
    void syncState();
    toast.warning("Um moderador mutou você nesta chamada.");
  } else {
    toast.info("O moderador liberou o seu microfone. Use o botão de microfone para falar.");
  }
}

/** Sons de quem chega, sai ou liga/desliga a transmissão na MINHA sala (nunca por mim mesmo). */
function playPeerSounds(
  myId: string | null,
  before: GatewayVoiceState | undefined,
  after: GatewayVoiceState,
) {
  const s = session();
  if (!myId || after.user_id === myId || s.status !== "connected" || !s.channelId) return;
  const wasHere = before?.channel_id === s.channelId;
  const isHere = after.channel_id === s.channelId;
  if (!wasHere && isHere) playCallSound("peer-join");
  else if (wasHere && !isHere) playCallSound("peer-leave");
  else if (isHere && !!before?.self_screen !== !!after.self_screen)
    playCallSound(after.self_screen ? "stream-start" : "stream-end");
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
    syncServerMute(!!mine.server_muted);
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
  serverMuted = false;
  generation++;
  clearTimeout(rejoinTimer);
  void engine?.disconnect();
  useVoiceStore.getState().reset();
  useVoiceStatesStore.getState().reset();
}
