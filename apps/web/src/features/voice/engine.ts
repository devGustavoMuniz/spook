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

/**
 * Nível de supressão de ruído do microfone:
 * - `off`: nenhum filtro;
 * - `standard`: o filtro embutido do navegador (web) ou do WebRTC (desktop);
 * - `strong`: modelo de IA gratuito (RNNoise) processando o áudio antes de publicar. Só vale onde a engine
 *   declara `audioCapabilities.strongNoiseSuppression`.
 */
export type NoiseSuppressionLevel = "off" | "standard" | "strong";

/**
 * Sensibilidade de entrada (porta de ruído), aplicada DEPOIS da supressão de ruído e válida para qualquer nível:
 * - `off`: sem porta;
 * - `auto`: limiar adaptativo (piso de ruído estimado + margem); `thresholdDb` é ignorado;
 * - `manual`: abre quando o nível passa de `thresholdDb` (dBFS, tipicamente -80 a -20).
 * Só vale onde a engine declara `audioCapabilities.inputSensitivity`.
 */
export type InputSensitivity = { mode: "off" | "auto" | "manual"; thresholdDb: number };

/** Processamento do microfone: eco, ruído (3 níveis), ganho e porta de ruído. Mesmo modelo na web e no desktop. */
export type AudioProcessingOptions = {
  echoCancellation: boolean;
  noiseSuppression: NoiseSuppressionLevel;
  autoGainControl: boolean;
  inputSensitivity: InputSensitivity;
};

/** Origem do áudio de um participante remoto: a voz (microfone) ou o som da tela compartilhada. */
export type AudioSource = "voice" | "screen";

/**
 * Qualidade do compartilhamento de tela. `height` e `fps` são o alvo da captura (e do teto de codificação);
 * `priority` vira o `contentHint` ("detail" = nitidez, "motion" = fluidez); `maxBitrateKbps` é o teto de subida
 * (ausente = o padrão da tabela, ver `screen-quality.ts`).
 */
export type ScreenShareQuality = {
  height: 720 | 1080 | 1440;
  fps: 15 | 30 | 60;
  priority: "detail" | "motion";
  maxBitrateKbps?: number;
};

/** Nível do microfone já processado (o que a porta enxerga), para o medidor da interface. */
export type InputLevel = { db: number; gateOpen: boolean };

/** Fases do teste de microfone (gravar ~5 s e tocar de volta). */
export type MicTestPhase = "requesting" | "recording" | "playing" | "done" | "error";
export type MicTestState = {
  phase: MicTestPhase;
  /** Tempo que falta na fase atual (gravando ou tocando), em ms. */
  remainingMs?: number;
  /** Só em `error`. */
  error?: MediaErrorCode;
};

/** O que a engine sabe fazer no processamento de áudio (a interface se adapta a isto, não ao ambiente). */
export type AudioCapabilities = {
  /** Nível "Forte" (IA) disponível nesta engine/navegador. */
  strongNoiseSuppression: boolean;
  /** Por que o "Forte" não está disponível (texto curto em pt-br para a interface; ex.: "em breve no app"). */
  strongUnavailableReason?: string;
  /** A engine consegue enviar o áudio do sistema/aba ao compartilhar a tela (ausente = sim). O desktop não. */
  screenShareAudio?: boolean;
  /**
   * Volume por participante (`setParticipantVolume`). `max` é o maior valor aceito (1 = 100%). Ausente = a engine
   * não ajusta volume por pessoa e a interface esconde os controles.
   */
  participantVolume?: { max: number };
  /** Porta de ruído (`inputSensitivity`) e medidor de nível (`setInputLevelMonitor` + evento `input-level`). */
  inputSensitivity?: boolean;
  /** Teste de microfone (`startMicTest`: grava ~5 s e reproduz no alto-falante escolhido). */
  micTest?: boolean;
  /** Qualidade do compartilhamento de tela (`setScreenShareEnabled(..., { quality })`). Ausente = não ajustável. */
  screenShareQuality?: boolean;
  /**
   * A engine permite capturar um quadro da tela compartilhada para a prévia da transmissão (miniatura enviada ao
   * servidor). Ausente = sim (a web desenha o vídeo num canvas); o desktop declara `false`: o vídeo da tela vem
   * do Rust e ainda não há quadro acessível ao WebView.
   */
  screenSharePreview?: boolean;
  /**
   * O vídeo remoto pode ir para uma janela flutuante (Picture-in-Picture). A engine web declara `true` quando o
   * navegador suporta; a nativa (vídeo em `<canvas>`) declara `false`.
   */
  pictureInPicture?: boolean;
};

/**
 * Estado real do processamento do microfone, para a interface ser honesta com o usuário:
 * `level` é o nível EM EFEITO (pode diferir do pedido se houve rebaixamento).
 */
export type AudioProcessingStatus = {
  level: NoiseSuppressionLevel;
  /** `loading`: baixando/iniciando o modelo; `active`: funcionando; `degraded`: IA rebaixada para "Padrão". */
  state: "idle" | "loading" | "active" | "degraded";
  /** Motivo do rebaixamento (pt-br), só em `degraded`. */
  reason?: string;
  /** Carga do processamento de IA: `high` quando o áudio está atrasando (ainda não rebaixou). */
  load?: "ok" | "high";
  /** A porta de ruído não subiu (pt-br): a chamada segue sem ela. */
  gateError?: string;
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
  /** O processamento do microfone mudou de estado (carregando a IA, ativa, rebaixada). Só a engine web emite. */
  "audio-processing-status": AudioProcessingStatus;
  /** Nível do microfone (~20 por segundo) enquanto `setInputLevelMonitor(true)`. */
  "input-level": InputLevel;
  /** Andamento do teste de microfone. */
  "mic-test": MicTestState;
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
  /**
   * Com `audio: true` pede o áudio do sistema quando a plataforma permite. `quality` só vale onde a engine declara
   * `audioCapabilities.screenShareQuality`; ausente = o padrão conservador da engine.
   */
  setScreenShareEnabled(
    enabled: boolean,
    opts?: { audio?: boolean; quality?: ScreenShareQuality },
  ): Promise<void>;
  /** Ensurdecer: silencia localmente todo o áudio remoto. Não mexe no microfone (isso é do controlador). */
  setDeafened(deafened: boolean): void;
  /** Retoma o áudio depois de `audio-blocked`. */
  resumeAudio(): Promise<void>;

  /**
   * Eco, ruído e ganho do microfone. A web aplica por constraints do `getUserMedia` (reiniciando só a captura
   * do microfone) e, no nível "strong", por um processador de IA no track; o desktop usa o APM do libwebrtc.
   * Opcional: a engine que não processa áudio não implementa.
   */
  setAudioProcessing?(options: AudioProcessingOptions): Promise<void>;
  /** Capacidades de áudio; ausente = nada além do básico. */
  readonly audioCapabilities?: AudioCapabilities;

  /**
   * Volume LOCAL de um participante remoto (só quem ouve é afetado). `volume` vai de 0 (mudo) até
   * `audioCapabilities.participantVolume.max`, com 1 = 100%. O valor vale para as faixas de `source` agora e as que
   * a pessoa publicar depois (a engine guarda o valor por identidade). O deafen (`setDeafened`) é independente e
   * continua silenciando tudo.
   */
  setParticipantVolume?(identity: Identity, source: AudioSource, volume: number): void;

  /**
   * Liga/desliga o medidor de nível do microfone (evento `input-level`). Em chamada com o microfone aberto mede a
   * faixa real publicada; fora dela (ou mudo) usa uma captura de teste separada, com o MESMO processamento
   * (`setAudioProcessing`). Rejeita com `VoiceMediaError` se o microfone não abre.
   */
  setInputLevelMonitor?(enabled: boolean): Promise<void>;
  /**
   * Teste de microfone: grava ~5 s do microfone já processado e reproduz no alto-falante escolhido (nunca ao vivo:
   * evita realimentação). O andamento sai pelo evento `mic-test`. Não faz nada se já houver um teste em curso.
   */
  startMicTest?(): Promise<void>;
  /** Interrompe o teste de microfone (idempotente). */
  cancelMicTest?(): void;

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
