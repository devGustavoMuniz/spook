// Espectadores da transmissão (adicional ao SPEC, 5.5): o LiveKit não diz ao backend quem assina cada tela, então o
// cliente avisa. Para cada tela que EU assisto (PUT /api/channels/{id}/voice/screen-watch/{user_id}) renova a marca a
// cada ~20 s (ela vale 45 s no servidor); ao parar de assistir, sair da chamada ou a transmissão acabar, para (e
// apaga, best effort). Quem transmite vê "Assistindo: N" e a lista; os demais veem só a contagem.
import { ApiError, deleteScreenWatch, putScreenWatch } from "@spook/shared";
import { useVoiceStatesStore, useVoiceStore } from "./store";

/** Intervalo entre as renovações (o servidor dá 45 s de validade). */
export const WATCH_HEARTBEAT_MS = 20_000;
/** Espera antes de tentar de novo quando o servidor ainda não me viu na sala (webhook atrasado) ou a rede falhou. */
const RETRY_MS = 3_000;
const MAX_QUICK_RETRIES = 5;

/**
 * Quem eu estou assistindo agora: com engine que escolhe as telas, o conjunto `watching`; sem ela (o app desktop
 * assina tudo), todo mundo que transmite no meu canal. Só conta quem de fato transmite e não sou eu.
 */
export function desiredWatchTargets(
  myId: string | null,
  channelId: string | null,
  selective: boolean,
  watching: ReadonlySet<string>,
  byUser: Readonly<Record<string, { channel_id: string | null; self_screen: boolean }>>,
): string[] {
  if (!channelId) return [];
  const out: string[] = [];
  for (const [id, st] of Object.entries(byUser)) {
    if (id === myId || st.channel_id !== channelId || !st.self_screen) continue;
    if (!selective || watching.has(id)) out.push(id);
  }
  return out.sort();
}

type Loop = { stop: (remote: boolean) => void };

function startLoop(channelId: string, userId: string, onGone: () => void): Loop {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  const tick = async () => {
    let ok = false;
    try {
      await putScreenWatch(channelId, userId);
      ok = true;
    } catch (err) {
      // 404: a transmissão acabou (ou saiu do canal); 422: é a minha própria tela. Não insiste. 403 (o servidor ainda
      // não me viu na sala), 429 e rede: tenta de novo daqui a pouco.
      if (err instanceof ApiError && (err.status === 404 || err.status === 422)) {
        onGone();
        return;
      }
    }
    if (stopped) return;
    failures = ok ? 0 : failures + 1;
    const quick = !ok && failures <= MAX_QUICK_RETRIES;
    timer = setTimeout(() => void tick(), quick ? RETRY_MS : WATCH_HEARTBEAT_MS);
  };
  void tick();
  return {
    stop: (remote) => {
      stopped = true;
      clearTimeout(timer);
      if (remote) void deleteScreenWatch(channelId, userId).catch(() => {});
    },
  };
}

/** Une o estado (sessão + estados de voz) ao conjunto de laços de renovação. Devolve a função que desliga tudo. */
export function startScreenWatchNotifier(opts: {
  myId: () => string | null;
  selective: () => boolean;
}): () => void {
  let channel: string | null = null;
  const loops = new Map<string, Loop>();

  const stopAll = (remote: boolean) => {
    for (const l of loops.values()) l.stop(remote);
    loops.clear();
  };

  const sync = () => {
    const s = useVoiceStore.getState();
    const connected = s.status === "connected" && !!s.channelId;
    const want = connected
      ? desiredWatchTargets(
          opts.myId(),
          s.channelId,
          opts.selective(),
          s.watching,
          useVoiceStatesStore.getState().byUser,
        )
      : [];
    if (channel !== (connected ? s.channelId : null)) {
      stopAll(false); // trocou de canal ou saiu: o servidor já tirou as marcas antigas
      channel = connected ? s.channelId : null;
    }
    if (!channel) return;
    const ch = channel;
    for (const [id, l] of loops) {
      if (!want.includes(id)) {
        l.stop(true);
        loops.delete(id);
      }
    }
    for (const id of want) {
      if (loops.has(id)) continue;
      const loop = startLoop(ch, id, () => {
        // A transmissão acabou antes de eu avisar: o próximo VOICE_STATE_UPDATE refaz a lista se ela voltar.
        loops.delete(id);
      });
      loops.set(id, loop);
    }
  };

  const unsubA = useVoiceStore.subscribe(sync);
  const unsubB = useVoiceStatesStore.subscribe(sync);
  sync();
  return () => {
    unsubA();
    unsubB();
    stopAll(true);
    channel = null;
  };
}
