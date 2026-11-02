// Sons de evento da chamada, SINTETIZADOS com WebAudio (osciladores e envelopes próprios, sem arquivos de terceiros).
// Regras: só depois de um gesto do usuário (política de autoplay), nada em "Não perturbar", um volume único e
// interruptores por categoria (Configurações > Voz e vídeo).
import { isDnd } from "@/features/presence/store";

export type CallSoundKind =
  | "join"
  | "leave"
  | "mute"
  | "unmute"
  | "deafen"
  | "undeafen"
  | "peer-join"
  | "peer-leave"
  | "stream-start"
  | "stream-end"
  | "ring";

/** Categorias que o usuário liga/desliga. */
export type CallSoundGroup = "self" | "toggles" | "peers" | "streams" | "ring";

export const SOUND_GROUPS: { id: CallSoundGroup; label: string; hint: string }[] = [
  { id: "self", label: "Entrar e sair da chamada", hint: "Quando você entra ou sai de uma sala." },
  {
    id: "toggles",
    label: "Microfone e áudio",
    hint: "Ao silenciar, ativar o microfone ou ensurdecer.",
  },
  {
    id: "peers",
    label: "Alguém entrou ou saiu",
    hint: "Quando uma pessoa chega ou sai da sua sala.",
  },
  {
    id: "streams",
    label: "Transmissões",
    hint: "Quando alguém começa ou termina de transmitir a tela.",
  },
  {
    id: "ring",
    label: "Toque de chamada",
    hint: "Toque de chamada recebida (para as chamadas diretas).",
  },
];

const GROUP_OF: Record<CallSoundKind, CallSoundGroup> = {
  join: "self",
  leave: "self",
  mute: "toggles",
  unmute: "toggles",
  deafen: "toggles",
  undeafen: "toggles",
  "peer-join": "peers",
  "peer-leave": "peers",
  "stream-start": "streams",
  "stream-end": "streams",
  ring: "ring",
};

export type CallSoundPrefs = { volume: number; groups: Record<CallSoundGroup, boolean> };

const KEY = "spook:call-sounds";
export const DEFAULT_CALL_SOUNDS: CallSoundPrefs = {
  volume: 0.5,
  groups: { self: true, toggles: true, peers: true, streams: true, ring: true },
};

export function loadCallSoundPrefs(): CallSoundPrefs {
  const out: CallSoundPrefs = {
    volume: DEFAULT_CALL_SOUNDS.volume,
    groups: { ...DEFAULT_CALL_SOUNDS.groups },
  };
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<CallSoundPrefs>;
    if (typeof raw.volume === "number" && Number.isFinite(raw.volume))
      out.volume = Math.min(1, Math.max(0, raw.volume));
    for (const g of SOUND_GROUPS)
      if (typeof raw.groups?.[g.id] === "boolean") out.groups[g.id] = raw.groups[g.id];
  } catch {
    // armazenamento indisponível ou corrompido: padrão
  }
  return out;
}

export function saveCallSoundPrefs(prefs: CallSoundPrefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // vale só nesta sessão
  }
}

type Note = {
  /** Frequência inicial (Hz) e final (glissando opcional). */
  f: number;
  to?: number;
  /** Início (s) e duração (s) relativos ao começo do som. */
  at: number;
  dur: number;
  gain?: number;
  type?: OscillatorType;
};

/** Receitas: cada som é uma lista de notas curtas. Sobem ao entrar/ativar e descem ao sair/silenciar. */
export const RECIPES: Record<CallSoundKind, Note[]> = {
  join: [
    { f: 440, at: 0, dur: 0.12 },
    { f: 660, at: 0.1, dur: 0.18 },
  ],
  leave: [
    { f: 560, at: 0, dur: 0.12 },
    { f: 330, at: 0.1, dur: 0.2 },
  ],
  mute: [{ f: 520, to: 340, at: 0, dur: 0.14, type: "triangle" }],
  unmute: [{ f: 340, to: 560, at: 0, dur: 0.14, type: "triangle" }],
  deafen: [
    { f: 480, to: 300, at: 0, dur: 0.12, type: "triangle" },
    { f: 360, to: 220, at: 0.12, dur: 0.14, type: "triangle" },
  ],
  undeafen: [
    { f: 300, to: 480, at: 0, dur: 0.12, type: "triangle" },
    { f: 400, to: 640, at: 0.12, dur: 0.14, type: "triangle" },
  ],
  "peer-join": [
    { f: 620, at: 0, dur: 0.1, gain: 0.7 },
    { f: 780, at: 0.09, dur: 0.12, gain: 0.7 },
  ],
  "peer-leave": [
    { f: 500, at: 0, dur: 0.1, gain: 0.7 },
    { f: 380, at: 0.09, dur: 0.12, gain: 0.7 },
  ],
  "stream-start": [
    { f: 392, at: 0, dur: 0.1, type: "square", gain: 0.5 },
    { f: 523, at: 0.09, dur: 0.1, type: "square", gain: 0.5 },
    { f: 784, at: 0.18, dur: 0.16, type: "square", gain: 0.5 },
  ],
  "stream-end": [
    { f: 784, at: 0, dur: 0.1, type: "square", gain: 0.5 },
    { f: 523, at: 0.09, dur: 0.1, type: "square", gain: 0.5 },
    { f: 392, at: 0.18, dur: 0.16, type: "square", gain: 0.5 },
  ],
  ring: [
    { f: 880, at: 0, dur: 0.22 },
    { f: 660, at: 0.25, dur: 0.22 },
    { f: 880, at: 0.6, dur: 0.22 },
    { f: 660, at: 0.85, dur: 0.22 },
  ],
};

/** Duração total (s) de um som. */
export const soundLength = (k: CallSoundKind) => Math.max(...RECIPES[k].map((n) => n.at + n.dur));

type Ctor = typeof AudioContext;
let ctx: AudioContext | null = null;
let gestured = false;
let armed = false;

/** Marca que houve um gesto do usuário (o AudioContext só é criado depois dele). */
export function noteUserGesture() {
  gestured = true;
}

function arm() {
  if (armed || typeof window === "undefined") return;
  armed = true;
  for (const ev of ["pointerdown", "keydown", "touchstart"] as const)
    window.addEventListener(ev, noteUserGesture, { capture: true, passive: true });
}
arm();

function audioContext(): AudioContext | null {
  if (ctx && ctx.state !== "closed") return ctx;
  if (!gestured) return null;
  const C: Ctor | undefined =
    typeof window === "undefined"
      ? undefined
      : ((window as unknown as { AudioContext?: Ctor }).AudioContext ??
        (window as unknown as { webkitAudioContext?: Ctor }).webkitAudioContext);
  if (!C) return null;
  try {
    ctx = new C();
  } catch {
    ctx = null;
  }
  return ctx;
}

/** Só testes: esquece o contexto e o gesto. */
export function resetCallSounds() {
  ctx = null;
  gestured = false;
  stopRing();
}

/** Toca um som de evento. Silencioso em DND, sem gesto prévio, com o grupo desligado ou volume 0. */
export function playCallSound(kind: CallSoundKind): boolean {
  const prefs = loadCallSoundPrefs();
  if (!prefs.groups[GROUP_OF[kind]] || prefs.volume <= 0) return false;
  if (isDnd()) return false;
  const ac = audioContext();
  if (!ac) return false;
  try {
    if (ac.state === "suspended") void ac.resume?.();
    const t0 = ac.currentTime + 0.01;
    const master = ac.createGain();
    // Curva suave: o controle é linear, o ouvido é logarítmico.
    master.gain.value = 0.25 * prefs.volume ** 2;
    master.connect(ac.destination);
    for (const n of RECIPES[kind]) {
      const osc = ac.createOscillator();
      const env = ac.createGain();
      osc.type = n.type ?? "sine";
      const start = t0 + n.at;
      osc.frequency.setValueAtTime(n.f, start);
      if (n.to) osc.frequency.linearRampToValueAtTime(n.to, start + n.dur);
      const peak = n.gain ?? 1;
      env.gain.setValueAtTime(0.0001, start);
      env.gain.exponentialRampToValueAtTime(peak, start + 0.015);
      env.gain.exponentialRampToValueAtTime(0.0001, start + n.dur);
      osc.connect(env);
      env.connect(master);
      osc.start(start);
      osc.stop(start + n.dur + 0.02);
    }
    return true;
  } catch {
    return false;
  }
}

let ringTimer: ReturnType<typeof setInterval> | undefined;

/** Toque de chamada recebida (gancho para as chamadas diretas): repete até `stopRing()`. */
export function startRing() {
  stopRing();
  playCallSound("ring");
  ringTimer = setInterval(() => playCallSound("ring"), 2500);
}

export function stopRing() {
  clearInterval(ringTimer);
  ringTimer = undefined;
}
