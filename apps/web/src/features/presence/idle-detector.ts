import type { ClientPresenceStatus } from "@spook/shared";

/** SPEC 7.6: ausente após 10 minutos sem interação, medido pelo cliente. */
export const IDLE_AFTER_MS = 10 * 60_000;

/**
 * Detector de inatividade sem DOM: quem chama `activity()` a cada interação (mouse, teclado, toque,
 * foco). Em vez de reiniciar um timer a cada movimento do mouse, guarda só o instante da última
 * interação e reagenda o único timer pelo que falta.
 */
export class IdleDetector {
  readonly #onChange: (status: ClientPresenceStatus) => void;
  readonly #timeoutMs: number;
  readonly #now: () => number;
  #status: ClientPresenceStatus = "online";
  #lastActivity: number;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: {
    onChange: (status: ClientPresenceStatus) => void;
    timeoutMs?: number;
    now?: () => number;
  }) {
    this.#onChange = opts.onChange;
    this.#timeoutMs = opts.timeoutMs ?? IDLE_AFTER_MS;
    this.#now = opts.now ?? Date.now;
    this.#lastActivity = this.#now();
  }

  get status(): ClientPresenceStatus {
    return this.#status;
  }

  start() {
    this.#lastActivity = this.#now();
    this.#schedule(this.#timeoutMs);
  }

  stop() {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  /** O usuário interagiu: volta a "online" (se estava ausente) e adia o prazo. */
  activity() {
    this.#lastActivity = this.#now();
    if (this.#status === "idle") {
      this.#status = "online";
      this.#onChange("online");
    }
    if (!this.#timer) this.#schedule(this.#timeoutMs);
  }

  #schedule(ms: number) {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#check(), ms);
  }

  #check() {
    this.#timer = null;
    const left = this.#timeoutMs - (this.#now() - this.#lastActivity);
    if (left > 0) return this.#schedule(left); // houve interação depois de armar o timer
    if (this.#status === "online") {
      this.#status = "idle";
      this.#onChange("idle");
    }
  }
}

const ACTIVITY_EVENTS = [
  "mousemove",
  "mousedown",
  "keydown",
  "touchstart",
  "wheel",
  "focus",
] as const;

/**
 * Liga o detector aos eventos do navegador (mouse, teclado, toque, foco e aba visível) e devolve a
 * função que desliga tudo. `onChange` recebe cada mudança de `online`/`idle`.
 */
export function watchIdle(
  onChange: (status: ClientPresenceStatus) => void,
  opts: { timeoutMs?: number; now?: () => number } = {},
): () => void {
  const detector = new IdleDetector({ onChange, ...opts });
  const activity = () => detector.activity();
  const visibility = () => {
    if (document.visibilityState === "visible") detector.activity();
  };
  for (const ev of ACTIVITY_EVENTS) window.addEventListener(ev, activity, { passive: true });
  document.addEventListener("visibilitychange", visibility);
  detector.start();
  return () => {
    for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, activity);
    document.removeEventListener("visibilitychange", visibility);
    detector.stop();
  };
}
