// Indicador de "falando" (anel verde): funções puras e testáveis, com relógio injetado (`now` em ms).
//
// Duas fontes se mesclam (OU) no controlador:
//  - o SERVIDOR (`ActiveSpeakersChanged` do LiveKit, ~200 ms de atualização): vale para todos; `SpeakerHold` só
//    acrescenta um "hold" de apagar (acende na hora; apaga se ficar `holdMs` sem aparecer) para o anel não piscar
//    nas lacunas entre atualizações;
//  - a leitura LOCAL do meu microfone (`LocalSpeakingDetector`): o anel do MEU tile acende sem esperar a ida e a
//    volta ao servidor. Usa o nível já processado (pós-ruído) e a porta de ruído que alimentam o medidor.

import type { InputLevel } from "./engine";

/** Tempo sem aparecer antes de apagar o anel (cobre a lacuna de uma atualização do servidor). */
export const SPEAKING_HOLD_MS = 250;
/** O nível precisa ficar acima do limiar por este tempo antes de acender (evita estalos e tosses curtas). */
export const SPEAKING_MIN_ON_MS = 60;
/** Limiar de nível (dBFS) para abrir quando NÃO há porta de ruído (o medidor é o único critério). */
export const SPEAKING_OPEN_DB = -50;
/** Com a porta de ruído ligada ela já decide o que é fala: o nível só descarta a cauda de ruído do hold da porta. */
export const SPEAKING_GATED_OPEN_DB = -55;
/** Histerese: depois de aceso, só deixa de contar como fala abaixo de (limiar - 4 dB). */
export const SPEAKING_HYSTERESIS_DB = 4;

/** Anti-pisca das identidades vindas do servidor. */
export class SpeakerHold {
  private lastSeen = new Map<string, number>();

  constructor(private readonly holdMs = SPEAKING_HOLD_MS) {}

  /** Lista atual do servidor: quem aparece acende imediatamente. */
  push(identities: readonly string[], now: number) {
    for (const id of identities) this.lastSeen.set(id, now);
  }

  /** Quem continua aceso em `now` (já descarta quem passou do hold). */
  active(now: number): string[] {
    for (const [id, seen] of this.lastSeen) if (now - seen >= this.holdMs) this.lastSeen.delete(id);
    return [...this.lastSeen.keys()];
  }

  /** Quando a próxima identidade apaga (ms), ou `null` se não há nenhuma acesa. */
  nextExpiry(): number | null {
    let min: number | null = null;
    for (const seen of this.lastSeen.values()) {
      const at = seen + this.holdMs;
      if (min === null || at < min) min = at;
    }
    return min;
  }

  clear() {
    this.lastSeen.clear();
  }
}

export type LocalSpeakingOptions = {
  /** A porta de ruído está ligada (`auto`/`manual`): exige `gateOpen` e usa o limiar mais baixo. */
  gate: boolean;
  holdMs?: number;
  minOnMs?: number;
};

/**
 * Decide se EU estou falando a partir das leituras do medidor (~20/s). Acende depois de `minOnMs` contínuos acima do
 * limiar; mantém aceso com histerese de 4 dB e só apaga `holdMs` depois da última leitura acima do limiar de fechar.
 */
export class LocalSpeakingDetector {
  private on = false;
  private candidateSince: number | null = null;
  private lastAbove = 0;
  private readonly holdMs: number;
  private readonly minOnMs: number;
  private gate: boolean;

  constructor(opts: LocalSpeakingOptions) {
    this.gate = opts.gate;
    this.holdMs = opts.holdMs ?? SPEAKING_HOLD_MS;
    this.minOnMs = opts.minOnMs ?? SPEAKING_MIN_ON_MS;
  }

  /** O usuário mudou a porta de ruído (liga/desliga). */
  setGate(gate: boolean) {
    this.gate = gate;
  }

  get speaking() {
    return this.on;
  }

  update(level: InputLevel, now: number): boolean {
    const open = this.gate ? SPEAKING_GATED_OPEN_DB : SPEAKING_OPEN_DB;
    const threshold = this.on ? open - SPEAKING_HYSTERESIS_DB : open;
    const above =
      Number.isFinite(level.db) && level.db >= threshold && (!this.gate || level.gateOpen);
    if (above) {
      this.lastAbove = now;
      if (!this.on) {
        this.candidateSince ??= now;
        if (now - this.candidateSince >= this.minOnMs) this.on = true;
      }
    } else {
      this.candidateSince = null;
    }
    return this.tick(now);
  }

  /** Reavalia só o tempo (sem leitura nova): apaga depois do hold. Chamado também por um timer. */
  tick(now: number): boolean {
    if (this.on && now - this.lastAbove >= this.holdMs) this.on = false;
    return this.on;
  }

  /** Quando o anel apagaria sem novas leituras (ms), ou `null` se está apagado. */
  nextExpiry(): number | null {
    return this.on ? this.lastAbove + this.holdMs : null;
  }

  reset() {
    this.on = false;
    this.candidateSince = null;
    this.lastAbove = 0;
  }
}

/**
 * Quem aparece falando: as identidades do servidor (já com hold) OU eu, se a leitura local diz que falo. Mudo
 * (`selfMute`) nunca acende, e também tira o meu anel que o servidor ainda não apagou (apaga na hora ao mutar).
 */
export function mergeSpeaking(
  remote: readonly string[],
  local: boolean,
  myId: string | null,
  selfMute: boolean,
): Set<string> {
  const out = new Set(remote);
  if (myId) {
    if (selfMute) out.delete(myId);
    else if (local) out.add(myId);
  }
  return out;
}

export function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}
