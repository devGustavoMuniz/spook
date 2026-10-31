// Interface da engine de mídia (SPEC 5.5, Fase 5 front). É a COSTURA para a Fase 7: o desktop (Tauri)
// troca a engine web (livekit-client / WebRTC do WebView) por uma nativa em Rust (RF12.2) implementando
// esta mesma interface. Nada fora de `web-engine.ts` pode importar `livekit-client` nem presumir
// `MediaStream`/`MediaStreamTrack`: a interface só fala em identidades, eventos e `VideoSource`.

/** Quem está falando com quem: a identidade da sala é o ID do usuário (o token a fixa). */
export type Identity = string;

export type ConnectParams = { url: string; token: string };

/** Por que a sala foi encerrada. */
export type DisconnectReason =
  /** Nós mesmos pedimos (sair, trocar de canal). */
  | "client"
  /** O servidor nos tirou (perdeu CONNECT/VIEW_CHANNEL, saiu do servidor, canal excluído, outra sessão). */
  | "removed"
  /** A lib desistiu de reconectar (rede, servidor reiniciando, token vencido). Vale pedir outro token. */
  | "network"
  | "unknown";

export type ConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting";

/** Qualidade do enlace do usuário local, como a engine mede. */
export type LinkQuality = "excellent" | "good" | "poor" | "lost" | "unknown";

export type VideoKind = "camera" | "screen";

/**
 * Onde o vídeo é desenhado, sem presumir como. A web cria um `<video>` dentro do `host` e chama
 * `track.attach(video)`; o desktop poderá criar um `<canvas>` e desenhar os quadros que o Rust enviar.
 * `attach` devolve a função que desfaz tudo (idempotente). Uma fonte pode ser montada em vários hosts.
 */
export interface VideoSource {
  attach(host: HTMLElement): () => void;
}

export type VideoTrackInfo = {
  /** Identificador estável da faixa (muda a cada nova publicação). */
  id: string;
  identity: Identity;
  kind: VideoKind;
  /** `true` para a minha própria câmera/tela (a prévia). */
  local: boolean;
  source: VideoSource;
};

export type DeviceKind = "audioinput" | "audiooutput" | "videoinput";
export type DeviceInfo = { id: string; label: string };

/** Processamento do microfone feito pela engine (só o desktop nativo): eco, ruído e ganho. */
export type AudioProcessingOptions = {
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
};

export type LocalMedia = { microphone: boolean; camera: boolean; screenShare: boolean };

/** Falha ao abrir mídia local; as telas traduzem o `code` em mensagem amigável. */
export type MediaErrorCode =
  | "permission-denied"
  | "cancelled"
  | "not-found"
  | "in-use"
  | "unsupported"
  | "unknown";

export class VoiceMediaError extends Error {
  constructor(
    readonly code: MediaErrorCode,
    readonly device: "microphone" | "camera" | "screen",
    message?: string,
    /** Mensagem pronta para o usuário (pt-br), quando a engine já sabe o que dizer (ex.: instruções do SO). */
    readonly userMessage?: string,
  ) {
    super(message ?? `${device}: ${code}`);
    this.name = "VoiceMediaError";
  }
}

export type ConnectErrorCode =
  /** O token foi recusado (vencido ou inválido): peça outro. */
  "token-rejected" | "unreachable" | "unknown";

export class VoiceConnectError extends Error {
  constructor(
    readonly code: ConnectErrorCode,
    message?: string,
  ) {
    super(message ?? `conexão de voz: ${code}`);
    this.name = "VoiceConnectError";
  }
}

export type VoiceEngineEvents = {
  /** Alguém entrou na sala (inclui quem já estava ao conectar). */
  "participant-joined": { identity: Identity };
  "participant-left": { identity: Identity };
  /** Quem está falando agora (substitui a lista anterior). */
  "speakers-changed": { identities: Identity[] };
  "video-track-added": VideoTrackInfo;
  "video-track-removed": { id: string };
  /** A lib está tentando reconectar (queda de rede) ou voltou. */
  "connection-state": { state: ConnectionState };
  "link-quality": { quality: LinkQuality };
  /** Mic/câmera/tela locais mudaram por fora do app (p. ex. o usuário parou a tela pela barra do navegador). */
  "local-media": LocalMedia;
  /** O navegador bloqueou a reprodução automática de áudio: chame `resumeAudio()` num gesto do usuário. */
  "audio-blocked": { blocked: boolean };
  "devices-changed": Record<string, never>;
  /** A sala foi encerrada. Depois disso `connect()` pode ser chamado de novo. */
  disconnected: { reason: DisconnectReason };
};

export type Unsubscribe = () => void;

export interface VoiceEngine {
  readonly state: ConnectionState;
  /** Entra na sala do token. Rejeita com `VoiceConnectError`. Se já houver sala, ela é encerrada antes. */
  connect(params: ConnectParams): Promise<void>;
  /** Sai da sala (emite `disconnected` com `client`). Idempotente. */
  disconnect(): Promise<void>;

  /** Rejeitam com `VoiceMediaError` (permissão negada, sem dispositivo, seleção de tela cancelada). */
  setMicrophoneEnabled(enabled: boolean): Promise<void>;
  setCameraEnabled(enabled: boolean): Promise<void>;
  /** Com `audio: true` pede o áudio do sistema quando a plataforma permite. */
  setScreenShareEnabled(enabled: boolean, opts?: { audio?: boolean }): Promise<void>;
  /** Ensurdecer: silencia localmente todo o áudio remoto. Não mexe no microfone (isso é do controlador). */
  setDeafened(deafened: boolean): void;
  /** Retoma o áudio depois de `audio-blocked`. */
  resumeAudio(): Promise<void>;

  /**
   * Opcional: só a engine que processa o áudio por conta própria (desktop nativo, com cancelamento de eco)
   * implementa. A web deixa isso com o navegador (`getUserMedia` já aplica AEC/NS/AGC).
   */
  setAudioProcessing?(options: AudioProcessingOptions): Promise<void>;

  listDevices(kind: DeviceKind): Promise<DeviceInfo[]>;
  /** Troca o dispositivo ativo (e o lembra para as próximas capturas). */
  setDevice(kind: DeviceKind, deviceId: string): Promise<void>;

  on<K extends keyof VoiceEngineEvents>(
    event: K,
    handler: (payload: VoiceEngineEvents[K]) => void,
  ): Unsubscribe;
}

/** Emissor tipado mínimo, compartilhado pelas implementações. */
export class Emitter<E extends Record<string, unknown>> {
  private handlers = new Map<keyof E, Set<(p: never) => void>>();

  on<K extends keyof E>(event: K, handler: (payload: E[K]) => void): Unsubscribe {
    const set = this.handlers.get(event) ?? new Set<(p: never) => void>();
    this.handlers.set(event, set);
    const h = handler as (p: never) => void;
    set.add(h);
    return () => set.delete(h);
  }

  protected emit<K extends keyof E>(event: K, payload: E[K]) {
    for (const h of [...(this.handlers.get(event) ?? [])]) (h as (p: E[K]) => void)(payload);
  }
}
