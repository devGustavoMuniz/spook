// Orquestra a chamada: token (API) + engine (mídia) + store (estado) + avisos. Sem React: funções
// de módulo, para o gateway, a barra de controle e os botões de canal usarem o mesmo fluxo.
import {
  apiFetch,
  createVoiceToken,
  type VoiceStatePayload as GatewayVoiceState,
  isApiError,
  leaveVoice,
  updateVoiceState,
} from "@spook/shared";
import { toast } from "sonner";
import { effectiveLimits, useLimitsStore } from "@/features/nitro/limits-store";
import type { PlanLimits } from "@/features/nitro/plans";
import { t } from "@/i18n";
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
  type AppAudioOptions,
  type AudioAppsResult,
  type AudioCapabilities,
  type AudioProcessingOptions,
  type AudioProcessingStatus,
  type ConnectionStats,
  type DeviceKind,
  type DisconnectReason,
  type InputLevel,
  type ScreenShareQuality,
  type Unsubscribe,
  VoiceConnectError,
  type VoiceEngine,
  VoiceMediaError,
} from "./engine";
import { createVoiceEngine } from "./engine-provider";
import { markJoin } from "./join-perf";
import { mediaMessage } from "./media-errors";
import { effectiveVolume, personVolumeOf, useParticipantVolumeStore } from "./participant-volume";
import { startScreenPreview } from "./screen-preview";
import { clampScreenQuality, loadScreenQuality, saveScreenQuality } from "./screen-quality";
import { startScreenWatchNotifier } from "./screen-watch";
import { LocalSpeakingDetector, mergeSpeaking, SpeakerHold, sameSet } from "./speaking";
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

// ---- Indicador de "falando": servidor (com hold anti-pisca) OU leitura local do meu microfone ----

const remoteSpeakers = new SpeakerHold();
const localSpeaker = new LocalSpeakingDetector({ gate: false });
let speakingTimer: ReturnType<typeof setTimeout> | undefined;

/** Recalcula `speaking` (servidor com hold + eu pela leitura local, sem mudo) e agenda o próximo apagar. */
function publishSpeaking() {
  const now = Date.now();
  clearTimeout(speakingTimer);
  const s = session();
  const next = mergeSpeaking(
    remoteSpeakers.active(now),
    localSpeaker.tick(now),
    knownMyId,
    s.selfMute,
  );
  if (!sameSet(next, s.speaking)) s.patch({ speaking: next });
  const expiries = [remoteSpeakers.nextExpiry(), localSpeaker.nextExpiry()].filter(
    (x): x is number => x !== null,
  );
  if (expiries.length > 0)
    speakingTimer = setTimeout(publishSpeaking, Math.max(0, Math.min(...expiries) - now) + 1);
}

/** Leitura do meu microfone (~20/s): só vale na chamada e com o microfone aberto. */
function onLocalLevel(l: InputLevel) {
  const s = session();
  if (s.status !== "connected" || s.selfMute) return;
  localSpeaker.setGate(loadAudioProcessing().inputSensitivity.mode !== "off");
  localSpeaker.update(l, Date.now());
  publishSpeaking();
}

/** Zera o indicador (entrada nova, saída, reconexão). */
function resetSpeaking() {
  clearTimeout(speakingTimer);
  remoteSpeakers.clear();
  localSpeaker.reset();
}

/** Liga/desliga a medição do microfone DA CHAMADA que alimenta o meu anel (`callOnly`: nunca abre captura de teste). */
function setCallMeter(eng: VoiceEngine | null, on: boolean) {
  void eng?.setInputLevelMonitor?.(on, { callOnly: true }).catch(() => {});
}

function ensureEngine(): VoiceEngine {
  if (engine) return engine;
  const e = createVoiceEngine();
  engine = e;
  unsubs = [
    e.on("speakers-changed", ({ identities }) => {
      remoteSpeakers.push(identities, Date.now());
      publishSpeaking();
    }),
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
    e.on("input-level", (l) => {
      useInputLevelStore.getState().set(l);
      onLocalLevel(l);
    }),
    e.on("mic-test", (s) => useMicTestStore.getState().set(s)),
    e.on("screen-black", ({ black }) => onScreenBlack(e, black)),
    e.on("disconnected", ({ reason }) => onDisconnected(reason)),
    useVoiceStore.subscribe(syncScreenPreview),
  ];
  return e;
}

/** Id do toast de "captura preta" (um só por vez; sai sozinho quando a captura volta ao normal). */
const SCREEN_BLACK_TOAST = "voice-screen-black";

/** A captura da MINHA tela ficou preta (ou voltou): avisa quem transmite, que não enxerga o que os outros veem. */
function onScreenBlack(e: VoiceEngine, black: boolean) {
  if (!black) return void toast.dismiss(SCREEN_BLACK_TOAST);
  const mac = typeof navigator !== "undefined" && /mac/i.test(navigator.userAgent);
  toast.warning(t("voice.toast.screenBlack"), {
    id: SCREEN_BLACK_TOAST,
    duration: Number.POSITIVE_INFINITY,
    ...(mac && e.openScreenCaptureSettings
      ? {
          action: {
            label: t("voice.toast.screenBlackAction"),
            onClick: () => e.openScreenCaptureSettings?.(),
          },
        }
      : {}),
  });
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
  toast.warning(status.reason ?? t("voice.toast.aiOff"));
}

/** Só para testes: solta a engine, os timers e o estado. */
export function resetVoiceController() {
  useAudioStatusStore.getState().set(null);
  useInputLevelStore.getState().set(null);
  useMicTestStore.getState().set(null);
  generation++;
  clearTimeout(rejoinTimer);
  resetSpeaking();
  for (const u of unsubs) u();
  unsubs = [];
  stopScreenPreview(false);
  engine = null;
  lastTarget = null;
  useVoiceStore.getState().reset();
  useLimitsStore.getState().setVoice(null);
}

async function fetchToken(channelId: string) {
  return createVoiceToken(channelId);
}

/** Entra (ou troca de canal). Devolve `true` se conectou. Erros viram aviso; nunca lança. */
export async function joinVoice(
  target: JoinTarget,
  /** Token já emitido (ex.: pela resposta de "Atender"): usado na primeira tentativa em vez de pedir outro. */
  prefetched?: { url: string; token: string; limits?: PlanLimits },
): Promise<boolean> {
  const s = session();
  if (s.channelId === target.channelId && s.status !== "idle") return true;
  markJoin("click");
  const gen = ++generation;
  clearTimeout(rejoinTimer);
  lastTarget = target;
  let eng: VoiceEngine;
  try {
    eng = ensureEngine();
  } catch (e) {
    toast.error(e instanceof Error ? e.message : t("voice.toast.unavailableApp"));
    return false;
  }
  // Pedir o token de outro canal já tira o usuário do anterior no servidor; o cliente sai da sala antiga.
  if (s.status !== "idle") await eng.disconnect();
  session().begin(target);
  resetSpeaking();
  // O microfone abre (e o RNNoise/porta carregam) EM PARALELO com o token e a conexão, não depois delas.
  const micPrepared = prepareMic(eng, target);
  setCallMeter(eng, true);
  const ok = await connectWithToken(eng, target, gen, prefetched);
  if (gen !== generation) return false;
  if (!ok) {
    eng.discardPreparedMicrophone?.();
    setCallMeter(eng, false);
    session().clear();
    return false;
  }
  await afterConnect(eng, target, gen, micPrepared);
  if (gen === generation) {
    markJoin("ready");
    playCallSound("join");
  }
  return gen === generation;
}

/**
 * Começa a abrir o microfone antes de a sala conectar, se a engine sabe e se a pessoa vai falar (não está mudo,
 * surdo nem sem permissão de falar). Sempre descarta um preparo anterior que tenha sobrado. `true` = preparado.
 */
function prepareMic(eng: VoiceEngine, target: JoinTarget): boolean {
  eng.discardPreparedMicrophone?.();
  const { selfMute, selfDeaf } = session();
  if (!eng.prepareMicrophone || selfMute || selfDeaf || !target.canSpeak || serverMuted)
    return false;
  // O processamento (eco/ruído/ganho/porta) vale para a captura que vai abrir já.
  void eng.setAudioProcessing?.(loadAudioProcessing()).catch(() => {});
  eng.prepareMicrophone();
  return true;
}

/** Token + conexão; com token recusado (vencido) pede outro uma vez. */
async function connectWithToken(
  eng: VoiceEngine,
  target: JoinTarget,
  gen: number,
  prefetched?: { url: string; token: string; limits?: PlanLimits },
) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let token: { url: string; token: string; limits?: PlanLimits };
    try {
      markJoin("token:start");
      token = attempt === 0 && prefetched ? prefetched : await fetchToken(target.channelId);
      markJoin("token:end");
      // O que o plano permite nesta sala (o servidor é quem decide; o motor publica no máximo isto).
      useLimitsStore.getState().setVoice(token.limits ?? null);
    } catch (err) {
      if (gen === generation) {
        toast.error(voiceMessage(err));
        if (isApiError(err) && err.status === 503) useVoiceAvailabilityStore.getState().set(true);
      }
      return false;
    }
    if (gen !== generation) return false;
    try {
      rememberVoiceUrl(token.url);
      markJoin("connect:start");
      await eng.connect({ url: token.url, token: token.token });
      markJoin("connect:end");
      useVoiceAvailabilityStore.getState().set(false);
      return gen === generation;
    } catch (err) {
      if (gen !== generation) return false;
      if (err instanceof VoiceConnectError && err.code === "token-rejected" && attempt === 0)
        continue;
      toast.error(t("voice.toast.connectFailed"));
      return false;
    }
  }
  return false;
}

const VOICE_URL_KEY = "spook:voice-url";
const PREWARM_EVERY_MS = 30_000;
let lastVoiceUrl: string | null = null;
let lastPrewarm = 0;

/** Guarda o endereço do servidor de mídia da última entrada (só o host: sem token), para pré-aquecer o próximo clique. */
function rememberVoiceUrl(url: string) {
  lastVoiceUrl = url;
  try {
    localStorage.setItem(VOICE_URL_KEY, url);
  } catch {
    // sem localStorage: vale só nesta sessão
  }
}

/**
 * O ponteiro passou (ou o foco chegou) num botão de entrar na voz: pré-aquece DNS/TLS do servidor de mídia e os
 * módulos do ruído/porta. NÃO pede token: emitir token tem efeito no servidor (tira o usuário do canal em que
 * está e marca a intenção de entrar, SPEC 7.7), então só se pede no clique. No máximo uma vez a cada 30 s.
 */
export function prewarmVoice() {
  const s = session();
  if (s.status !== "idle") return;
  const now = Date.now();
  if (now - lastPrewarm < PREWARM_EVERY_MS) return;
  lastPrewarm = now;
  try {
    lastVoiceUrl ??= localStorage.getItem(VOICE_URL_KEY);
  } catch {
    // ignora
  }
  try {
    ensureEngine().prewarm?.(lastVoiceUrl ?? undefined);
  } catch {
    // engine indisponível: nada a aquecer
  }
}

let knownMyId: string | null = null;
let stopWatchNotifier: (() => void) | null = null;

/** Liga (uma vez) o aviso ao backend de quais telas estou assistindo: ele alimenta "Assistindo: N" de quem transmite. */
function ensureWatchNotifier() {
  if (stopWatchNotifier) return;
  stopWatchNotifier = startScreenWatchNotifier({
    myId: () => knownMyId,
    selective: () => screenWatchSupported(),
  });
}

async function afterConnect(
  eng: VoiceEngine,
  target: JoinTarget,
  gen: number,
  /** O microfone já foi aberto em paralelo com a conexão (`prepareMic`): só falta publicá-lo. */
  micPrepared = false,
) {
  session().patch({ status: "connected" });
  ensureWatchNotifier();
  // Reaplica as telas que o usuário escolheu assistir (a engine começa sem assinar nenhuma).
  for (const id of session().watching) eng.setScreenWatching?.(id, true);
  const prefs = loadDevicePrefs();
  const { selfMute, selfDeaf } = session();
  eng.setDeafened(selfDeaf);
  const micOn = !selfMute && !selfDeaf && target.canSpeak;
  if (!micOn) eng.discardPreparedMicrophone?.();

  // Microfone: dispositivo -> processamento -> publicação (o dispositivo e o processamento já valeram na captura
  // preparada). Corre em paralelo com a escolha do alto-falante e da câmera, que não dependem dele.
  const mic = (async () => {
    if (!micPrepared) {
      if (prefs.audioinput) await eng.setDevice("audioinput", prefs.audioinput).catch(() => {});
      await eng.setAudioProcessing?.(loadAudioProcessing()).catch(() => {});
    }
    if (!micOn) return;
    try {
      markJoin("mic:start");
      await eng.setMicrophoneEnabled(true);
      markJoin("mic:end");
    } catch (err) {
      if (gen !== generation) return;
      // Sem microfone: entra mudo (como ouvinte) e explica.
      reportMediaIssue(err);
      session().patch({ selfMute: true, muteBeforeDeaf: true });
    }
  })();
  const others = (["audiooutput", "videoinput"] as const).map(async (kind) => {
    const id = prefs[kind];
    if (id) await eng.setDevice(kind, id).catch(() => {});
  });
  await Promise.all([mic, ...others]);
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
  toast.dismiss(SCREEN_BLACK_TOAST);
  eng?.discardPreparedMicrophone?.();
  setCallMeter(eng ?? null, false);
  resetSpeaking();
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
    toast.error(t("voice.toast.modMutedBlocked"));
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
  publishSpeaking(); // mudo apaga o meu anel na hora
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
    publishSpeaking();
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
  /** Áudio por aplicativo (só repassado a engines com `screenShareAppAudio`). */
  appAudio?: AppAudioOptions;
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
  // O que o motor publica nunca passa do plano: limites do token da sala (senão do plano, senão grátis).
  const quality =
    on && engine.audioCapabilities?.screenShareQuality
      ? clampScreenQuality(opts?.quality ?? loadScreenQuality(), effectiveLimits())
      : undefined;
  if (on && quality && opts?.quality) saveScreenQuality(quality);
  try {
    const appAudio =
      on && audio && opts?.appAudio && engine.audioCapabilities?.screenShareAppAudio
        ? opts.appAudio
        : undefined;
    await engine.setScreenShareEnabled(on, {
      audio,
      ...(quality ? { quality } : {}),
      ...(appAudio ? { appAudio } : {}),
    });
    session().patch({ screen: on, screenPreview: preview, mediaIssue: null });
    if (!on) toast.dismiss(SCREEN_BLACK_TOAST);
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

/** Aplicativos com som agora, para o diálogo de compartilhar tela (vazio e "sem suporte" quando a engine não lista). */
export async function listAudioApps(): Promise<AudioAppsResult> {
  const e = ensureEngine();
  if (!e.listAudioApps) return { supported: false, reason: "platform", apps: [] };
  return e.listAudioApps();
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
  if (reason === "removed") return forcedOut(t("voice.toast.disconnected"));
  void rejoin(generation, 0);
}

/** A lib desistiu de reconectar (rede, token vencido ao reconectar): tenta entrar de novo com outro token. */
async function rejoin(gen: number, attempt: number) {
  const target = lastTarget;
  if (!target) return forcedOut(t("voice.toast.connectionLost"));
  // O webhook de saída da sala velha chega como "saí": sem confirmação ele é ignorado até a nova entrada.
  session().patch({
    status: "reconnecting",
    speaking: new Set(),
    videoTracks: [],
    confirmed: false,
  });
  resetSpeaking();
  const delay = REJOIN_DELAYS_MS[attempt];
  if (delay === undefined) return forcedOut(t("voice.toast.connectionLost"));
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
  toast.dismiss(SCREEN_BLACK_TOAST);
  engine?.discardPreparedMicrophone?.();
  setCallMeter(engine, false);
  resetSpeaking();
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
  if (myId) knownMyId = myId;
  const before = useVoiceStatesStore.getState().byUser[u.user_id];
  useVoiceStatesStore.getState().apply(u);
  playPeerSounds(myId, before, u);
  if (!myId || u.user_id !== myId) return;
  const s = session();
  if (s.status === "idle") return;
  if (u.channel_id === s.channelId) {
    if (!s.confirmed) {
      s.patch({ confirmed: true });
      markJoin("confirmed");
    }
    syncServerMute(!!u.server_muted);
    return;
  }
  if (!s.confirmed) return;
  forcedOut(u.channel_id ? t("voice.toast.otherDevice") : t("voice.toast.disconnected"));
}

/** O servidor mutou (ou liberou) o MEU microfone: bloqueia/libera o botão, silencia a captura e avisa. */
function syncServerMute(muted: boolean) {
  if (muted === serverMuted) return;
  serverMuted = muted;
  if (muted) {
    session().patch({ selfMute: true, muteBeforeDeaf: true });
    publishSpeaking();
    // O servidor derruba a faixa ao revogar a permissão: descarta a nossa para a próxima ligada publicar uma nova.
    void engine
      ?.setMicrophoneEnabled(false)
      .then(() => engine?.resetMicrophone?.())
      .catch(() => {});
    void syncState();
    toast.warning(t("voice.toast.modMuted"));
  } else {
    toast.info(t("voice.toast.modUnmuted"));
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
  if (myId) knownMyId = myId;
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
  if (s.confirmed) forcedOut(t("voice.toast.disconnected"));
}

/** Aba fechando: desconecta e avisa o servidor sem esperar (a requisição sobrevive à página). */
export function leaveOnPageHide() {
  if (session().status === "idle") return;
  void engine?.disconnect();
  try {
    // `apiFetch`: no desktop vai à URL absoluta com o Bearer (um `fetch` relativo cairia em tauri.localhost, sem sessão).
    void apiFetch("/api/voice/leave", { method: "POST", keepalive: true }).catch(() => {});
  } catch {
    // o servidor tira o usuário pelo webhook do LiveKit quando a conexão cai
  }
}

/** Área autenticada desmontada (sair da conta): solta a sala local; a sessão já não permite avisar o servidor. */
export function shutdownVoice() {
  serverMuted = false;
  generation++;
  clearTimeout(rejoinTimer);
  engine?.discardPreparedMicrophone?.();
  setCallMeter(engine, false);
  resetSpeaking();
  void engine?.disconnect();
  useVoiceStore.getState().reset();
  useVoiceStatesStore.getState().reset();
  useLimitsStore.getState().setVoice(null);
}
