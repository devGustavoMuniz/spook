// Cliente do gateway (SPEC 5.3, RNF07), agnóstico de React e de ambiente: o WebSocket e a obtenção
// do ticket são injetáveis (web usa o cookie; desktop usa `POST /api/gateway/ticket`).
//
// Ciclo: HELLO -> IDENTIFY (ou RESUME) -> READY/RESUMED -> heartbeats. Qualquer queda reconecta com
// backoff exponencial + jitter e tenta o RESUME (sessão + último `s`); op 9 refaz o IDENTIFY na
// mesma conexão e avisa `onInvalidated` (o app deve refazer os GETs, pois eventos podem ter se perdido).
import { isApiError } from "../http";
import {
  CloseCode,
  eventSchemas,
  frameSchema,
  type GatewayEvent,
  type GatewayEventData,
  type GatewayEventName,
  helloDataSchema,
  isGatewayEventName,
  Op,
  shouldReconnectOnClose,
} from "./schemas";

export type GatewayStatus = "connecting" | "connected" | "reconnecting" | "closed";

export type GatewayErrorKind = "auth" | "taken_over" | "protocol" | "network";
export type GatewayError = { kind: GatewayErrorKind; message: string; code?: number };

/** Subconjunto do `WebSocket` que o cliente usa (permite um falso nos testes). */
export interface GatewaySocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type GatewaySocketFactory = (url: string) => GatewaySocket;

export type ReadyData = GatewayEventData<"READY">;
export type ResumedData = GatewayEventData<"RESUMED">;

export interface GatewayOptions {
  /** `ws://` ou `wss://` completo (veja `gatewayUrl`). */
  url: string;
  /** Desktop: obtém um ticket novo a cada conexão (`?ticket=`). Web (cookie): omita. */
  getTicket?: () => Promise<string>;
  /** Valor de `identify.d.client` (web, desktop…). */
  client?: string;
  /** Padrão: `new WebSocket(url)` global. */
  socketFactory?: GatewaySocketFactory;
  /** Padrão: `Math.random` (injetável para testes). */
  random?: () => number;
  /** Backoff: base e teto, em ms (padrão 1 s e 30 s). */
  backoff?: { baseMs?: number; maxMs?: number };
  /** Prazo para o HELLO chegar depois de abrir a conexão (padrão 15 s). */
  connectTimeoutMs?: number;
  /** Prazo para o ack de um heartbeat; passou, a conexão é considerada morta (padrão 15 s). */
  ackTimeoutMs?: number;
  onStatusChange?: (status: GatewayStatus) => void;
  /** READY chegou. `reconnect` = já havia uma sessão antes (a anterior se perdeu). */
  onReady?: (ready: ReadyData, info: { reconnect: boolean }) => void;
  onResumed?: (resumed: ResumedData) => void;
  /** Eventos podem ter se perdido (sessão nova depois de uma antiga, op 9 ou buraco em `s`): refaça os GETs. */
  onInvalidated?: () => void;
  onError?: (error: GatewayError) => void;
}

const DEFAULT_BASE_MS = 1_000;
const DEFAULT_MAX_MS = 30_000;
const RATE_LIMIT_FLOOR_MS = 5_000;

/** `http(s)://host` (ou `location.origin`) -> `ws(s)://host/api/gateway`. */
export function gatewayUrl(origin: string): string {
  return `${origin.replace(/^http/i, "ws").replace(/\/+$/, "")}/api/gateway`;
}

type Timer = ReturnType<typeof setTimeout>;
type Listener = (event: GatewayEvent) => void;

export class GatewayClient {
  readonly #o: GatewayOptions;
  #status: GatewayStatus = "closed";
  #socket: GatewaySocket | null = null;
  /** Invalida eventos de sockets antigos (um socket descartado pode ainda disparar `onclose`). */
  #gen = 0;
  #running = false;
  #sessionId: string | null = null;
  #seq: number | null = null;
  #hadReady = false;
  #attempt = 0;
  #reconnectTimer: Timer | null = null;
  #connectTimer: Timer | null = null;
  #heartbeatTimer: Timer | null = null;
  #ackTimer: Timer | null = null;
  readonly #listeners = new Set<Listener>();

  constructor(options: GatewayOptions) {
    this.#o = options;
  }

  get status(): GatewayStatus {
    return this.#status;
  }
  get sessionId(): string | null {
    return this.#sessionId;
  }
  /** Último `s` entregue (base do RESUME). */
  get lastSeq(): number | null {
    return this.#seq;
  }

  /** Recebe todos os eventos de dispatch (inclusive READY/RESUMED), já validados. */
  onEvent(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Atalho tipado para um único evento. */
  on<K extends GatewayEventName>(t: K, handler: (d: GatewayEventData<K>) => void): () => void {
    return this.onEvent((e) => {
      if (e.t === t) handler(e.d as GatewayEventData<K>);
    });
  }

  /** Abre a conexão (sessão nova). Sem efeito se já estiver ativa. */
  connect(): void {
    if (this.#running) return;
    this.#running = true;
    this.#sessionId = null;
    this.#seq = null;
    this.#hadReady = false;
    this.#attempt = 0;
    this.#setStatus("connecting");
    void this.#open();
  }

  /** Encerra de vez (logout, desmontar). Pode chamar `connect()` depois para uma sessão nova. */
  close(): void {
    this.#running = false;
    this.#teardown(1000, "bye");
    this.#clearReconnect();
    this.#sessionId = null;
    this.#seq = null;
    this.#setStatus("closed");
  }

  /**
   * A rede voltou ou a aba ficou visível: se estiver esperando o backoff, reconecta já; se parece
   * conectado, sonda com um heartbeat (sem ack no prazo a conexão é derrubada e retomada).
   */
  reconnectNow(): void {
    if (!this.#running) return;
    if (this.#reconnectTimer) {
      this.#clearReconnect();
      this.#attempt = 0;
      void this.#open();
    } else if (this.#status === "connected") {
      this.#sendHeartbeat();
    }
  }

  /** O navegador avisou que ficou sem rede: não espera o heartbeat para perceber. */
  notifyOffline(): void {
    if (!this.#running || this.#status !== "connected") return;
    this.#lost();
  }

  // ---- conexão ----

  async #open(): Promise<void> {
    const gen = ++this.#gen;
    let url = this.#o.url;
    if (this.#o.getTicket) {
      try {
        const ticket = await this.#o.getTicket();
        url += `${url.includes("?") ? "&" : "?"}ticket=${encodeURIComponent(ticket)}`;
      } catch (e) {
        if (gen !== this.#gen || !this.#running) return;
        const auth = isApiError(e) && (e.status === 401 || e.status === 403);
        this.#fail({
          kind: auth ? "auth" : "network",
          message: e instanceof Error ? e.message : "falha ao obter o ticket",
        });
        if (auth) this.#stop();
        else this.#scheduleReconnect();
        return;
      }
      if (gen !== this.#gen || !this.#running) return;
    }

    let socket: GatewaySocket;
    try {
      socket = (this.#o.socketFactory ?? defaultFactory)(url);
    } catch (e) {
      this.#fail({
        kind: "network",
        message: e instanceof Error ? e.message : "falha ao conectar",
      });
      this.#scheduleReconnect();
      return;
    }
    this.#socket = socket;
    this.#connectTimer = setTimeout(() => this.#lost(), this.#o.connectTimeoutMs ?? 15_000);

    const live = () => gen === this.#gen;
    socket.onmessage = (ev) => live() && this.#onMessage(ev.data);
    socket.onclose = (ev) => live() && this.#onClose(ev.code);
    socket.onerror = () => {
      // O `close` vem logo depois e dispara a reconexão; aqui não há nada a fazer.
    };
  }

  #onClose(code: number) {
    if (!shouldReconnectOnClose(code)) {
      this.#teardown();
      this.#fail({
        kind: "taken_over",
        message: "A sessão foi aberta em outra conexão.",
        code,
      });
      this.#stop();
      return;
    }
    this.#lost(code);
  }

  /** Conexão perdida (ou considerada morta): derruba o socket e agenda a reconexão com resume. */
  #lost(code?: number) {
    this.#teardown(4000, "reconnecting");
    if (!this.#running) return;
    this.#setStatus("reconnecting");
    this.#scheduleReconnect(code === CloseCode.rate_limited ? RATE_LIMIT_FLOOR_MS : 0);
  }

  #stop() {
    this.#running = false;
    this.#clearReconnect();
    this.#setStatus("closed");
  }

  #teardown(code?: number, reason?: string) {
    this.#gen++;
    if (this.#connectTimer) clearTimeout(this.#connectTimer);
    if (this.#heartbeatTimer) clearTimeout(this.#heartbeatTimer);
    if (this.#ackTimer) clearTimeout(this.#ackTimer);
    this.#connectTimer = this.#heartbeatTimer = this.#ackTimer = null;
    const s = this.#socket;
    this.#socket = null;
    if (!s) return;
    s.onopen = s.onmessage = s.onclose = s.onerror = null;
    if (code !== undefined) {
      try {
        s.close(code, reason);
      } catch {
        // já fechado
      }
    }
  }

  #scheduleReconnect(floorMs = 0) {
    this.#clearReconnect();
    const { baseMs = DEFAULT_BASE_MS, maxMs = DEFAULT_MAX_MS } = this.#o.backoff ?? {};
    const cap = Math.min(maxMs, baseMs * 2 ** this.#attempt);
    const rand = this.#o.random ?? Math.random;
    // "Equal jitter": metade fixa + metade aleatória (evita rajada de reconexões e laço apertado).
    const delay = Math.max(floorMs, cap / 2 + (rand() * cap) / 2);
    this.#attempt++;
    if (this.#status !== "reconnecting") this.#setStatus("reconnecting");
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      void this.#open();
    }, delay);
  }

  #clearReconnect() {
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
  }

  // ---- protocolo ----

  #send(op: number, d: unknown) {
    try {
      this.#socket?.send(JSON.stringify({ op, t: null, s: null, d }));
    } catch {
      this.#lost();
    }
  }

  #sendHeartbeat() {
    if (this.#ackTimer) return; // já há um heartbeat esperando ack
    this.#send(Op.Heartbeat, this.#seq);
    this.#ackTimer = setTimeout(() => this.#lost(), this.#o.ackTimeoutMs ?? 15_000);
  }

  #startHeartbeats(intervalMs: number) {
    const tick = () => {
      this.#sendHeartbeat();
      this.#heartbeatTimer = setTimeout(tick, intervalMs);
    };
    // O primeiro com jitter (como o Discord), os demais a cada intervalo.
    this.#heartbeatTimer = setTimeout(tick, (this.#o.random ?? Math.random)() * intervalMs);
  }

  #onMessage(raw: unknown) {
    let json: unknown;
    try {
      json = JSON.parse(typeof raw === "string" ? raw : String(raw));
    } catch {
      return this.#fail({ kind: "protocol", message: "frame não é JSON" });
    }
    const frame = frameSchema.safeParse(json);
    if (!frame.success) return this.#fail({ kind: "protocol", message: "frame inválido" });
    const { op, t, s, d } = frame.data;

    switch (op) {
      case Op.Hello: {
        const hello = helloDataSchema.safeParse(d);
        if (!hello.success) return this.#fail({ kind: "protocol", message: "HELLO inválido" });
        if (this.#connectTimer) clearTimeout(this.#connectTimer);
        this.#connectTimer = null;
        this.#startHeartbeats(hello.data.heartbeat_interval);
        if (this.#sessionId !== null && this.#seq !== null)
          this.#send(Op.Resume, { session_id: this.#sessionId, seq: this.#seq });
        else this.#send(Op.Identify, this.#o.client ? { client: this.#o.client } : {});
        return;
      }
      case Op.Ack:
        if (this.#ackTimer) clearTimeout(this.#ackTimer);
        this.#ackTimer = null;
        return;
      case Op.Heartbeat: // o servidor pediu: responde já
        this.#sendHeartbeat();
        return;
      case Op.InvalidSession:
        // A sessão se perdeu: identify de novo na mesma conexão; o READY seguinte avisa `onInvalidated`.
        this.#sessionId = null;
        this.#seq = null;
        this.#send(Op.Identify, this.#o.client ? { client: this.#o.client } : {});
        return;
      case Op.Dispatch:
        if (t !== null) this.#dispatch(t, s, d);
        return;
      default:
        return; // op desconhecido: ignora (compatibilidade futura)
    }
  }

  #dispatch(t: string, s: number | null, d: unknown) {
    if (!isGatewayEventName(t)) {
      this.#advance(s);
      return; // evento que este cliente não conhece
    }
    const parsed = eventSchemas[t].safeParse(d);

    if (t === "READY") {
      if (!parsed.success) return this.#fail({ kind: "protocol", message: "READY inválido" });
      const ready = parsed.data as ReadyData;
      const reconnect = this.#hadReady;
      this.#sessionId = ready.session_id;
      this.#seq = s;
      this.#hadReady = true;
      this.#attempt = 0;
      this.#setStatus("connected");
      this.#emit({ t: "READY", d: ready }, () => this.#o.onReady?.(ready, { reconnect }));
      if (reconnect) this.#invalidate();
      return;
    }
    if (t === "RESUMED") {
      if (!parsed.success) return this.#fail({ kind: "protocol", message: "RESUMED inválido" });
      const resumed = parsed.data as ResumedData;
      this.#attempt = 0;
      this.#setStatus("connected");
      this.#emit({ t: "RESUMED", d: resumed }, () => this.#o.onResumed?.(resumed));
      return;
    }

    // Deduplicação e ordem por `s`: repetido/antigo é descartado; buraco = eventos perdidos.
    if (s !== null && this.#seq !== null) {
      if (s <= this.#seq) return;
      if (s > this.#seq + 1) this.#invalidate();
    }
    this.#advance(s);
    if (!parsed.success)
      return this.#fail({ kind: "protocol", message: `payload inválido em ${t}` });
    this.#emit({ t, d: parsed.data } as GatewayEvent);
  }

  #advance(s: number | null) {
    if (s !== null && (this.#seq === null || s > this.#seq)) this.#seq = s;
  }

  // ---- saídas ----

  #emit(event: GatewayEvent, extra?: () => void) {
    for (const l of this.#listeners) this.#guard(() => l(event));
    if (extra) this.#guard(extra);
  }

  #invalidate() {
    this.#guard(() => this.#o.onInvalidated?.());
  }

  #guard(fn: () => void) {
    try {
      fn();
    } catch (e) {
      // um handler com erro não pode derrubar a conexão nem os demais handlers
      this.#fail({ kind: "protocol", message: e instanceof Error ? e.message : "erro no handler" });
    }
  }

  #fail(error: GatewayError) {
    try {
      this.#o.onError?.(error);
    } catch {
      // ignora erro do próprio handler de erro
    }
  }

  #setStatus(status: GatewayStatus) {
    if (this.#status === status) return;
    this.#status = status;
    this.#guard(() => this.#o.onStatusChange?.(status));
  }
}

const defaultFactory: GatewaySocketFactory = (url) =>
  new WebSocket(url) as unknown as GatewaySocket;
