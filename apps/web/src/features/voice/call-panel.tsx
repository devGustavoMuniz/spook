import { type ChannelPayload, useGetMe, type VoiceStatePayload } from "@spook/shared";
import { Phone, PhoneOff } from "lucide-react";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { dmTitle } from "@/features/dms/dm-utils";
import { cancelCall, placeCall } from "@/features/social/call-actions";
import { useCallStore } from "@/features/social/call-store";
import { cn } from "@/lib/utils";
import { joinVoice, leaveCall, watchStream } from "./controller";
import { VoiceStage } from "./stage/voice-stage";
import { participantsOf, useVoiceStatesStore, useVoiceStore } from "./store";
import { usePersonLookup } from "./use-person-lookup";
import { VoiceParticipants } from "./voice-participants";

/** Quantas pessoas estão na chamada do canal (DM ou canal de voz). */
export function useCallParticipants(channelId: string) {
  const byUser = useVoiceStatesStore((s) => s.byUser);
  return participantsOf(byUser, channelId);
}

/**
 * Quem aparece no palco: os estados do servidor e, enquanto o meu ainda não chegou (o voice state vem do
 * webhook do LiveKit), um tile provisório meu: quem está na chamada sempre se vê.
 */
export function useStageParticipants(channelId: string, guildId: string | null, inCall: boolean) {
  const { data: me } = useGetMe();
  const list = useCallParticipants(channelId);
  return useMemo(() => {
    if (!inCall || !me || list.some((p) => p.user_id === me.id)) return list;
    const mine: VoiceStatePayload = {
      guild_id: guildId,
      channel_id: channelId,
      user_id: me.id,
      self_mute: false,
      self_deaf: false,
      self_video: false,
      self_screen: false,
      screen_preview: false,
    };
    return [mine, ...list];
  }, [list, me, inCall, channelId, guildId]);
}

/**
 * Botão de chamada no cabeçalho da DM (sala = ID da DM). "Ligar" faz as outras pessoas tocarem (até 45 s) e entra
 * na sala; enquanto ninguém atende mostra "Chamando…" com "Cancelar". Com uma chamada já em andamento vira
 * "Entrar na chamada" (sem tocar de novo) e, dentro dela, "Em chamada" + "Sair da chamada".
 */
export function DmCallButton({ channel }: { channel: ChannelPayload }) {
  const { data: me } = useGetMe();
  const inThis = useVoiceStore((s) => s.channelId === channel.id && s.status !== "idle");
  const connecting = useVoiceStore((s) => s.status === "connecting");
  const ringing = useCallStore((s) => !!s.outgoing[channel.id]);
  const participants = useCallParticipants(channel.id);
  if (!me) return null;
  const ongoing = participants.length > 0;
  const title = dmTitle(channel, me.id);

  if (inThis && ringing)
    return (
      <div className="flex items-center gap-2">
        <output className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Phone aria-hidden className="size-4 animate-pulse" /> Chamando…
        </output>
        <Button variant="destructive" size="sm" onClick={() => void cancelCall(channel.id)}>
          <PhoneOff /> Cancelar
        </Button>
      </div>
    );
  if (inThis)
    return (
      <div className="flex items-center gap-2">
        <span className="hidden items-center gap-1.5 text-sm text-emerald-600 sm:flex dark:text-emerald-400">
          <span aria-hidden className="size-2 rounded-full bg-emerald-500" /> Em chamada
        </span>
        <Button variant="destructive" size="sm" onClick={() => void leaveCall()}>
          <PhoneOff /> Sair da chamada
        </Button>
      </div>
    );
  return (
    <Button
      variant={ongoing ? "default" : "outline"}
      size="sm"
      disabled={connecting}
      onClick={() =>
        void (ongoing
          ? joinVoice({ channelId: channel.id, guildId: null, channelName: title, canSpeak: true })
          : placeCall(channel.id, title))
      }
    >
      <Phone /> {ongoing ? "Entrar na chamada" : "Ligar"}
    </Button>
  );
}

/** Faixa no topo da DM: chamada em andamento (quem está nela) e, se estou nela, o vídeo. */
export function DmCallPanel({ channel }: { channel: ChannelPayload }) {
  const { data: me } = useGetMe();
  const inThis = useVoiceStore((s) => s.channelId === channel.id && s.status !== "idle");
  const participants = useStageParticipants(channel.id, null, inThis);
  const lookup = usePersonLookup({ guildId: null, dmId: channel.id });
  if (participants.length === 0 && !inThis) return null;
  return (
    <section
      aria-label="Chamada em andamento"
      className={cn(
        "flex flex-col border-b bg-muted/40",
        inThis && "h-[60%] min-h-80 shrink-0 bg-surface-1",
      )}
    >
      <div className="flex items-center gap-2 px-4 py-2 text-sm">
        <span className="size-2 rounded-full bg-emerald-500" aria-hidden />
        <span className="font-medium">Chamada em andamento</span>
        <span className="text-muted-foreground">
          {participants.length} {participants.length === 1 ? "pessoa" : "pessoas"}
        </span>
      </div>
      {inThis ? (
        <VoiceStage
          participants={participants}
          lookup={lookup}
          inCall
          leaveLabel="Desligar a chamada"
        />
      ) : (
        <VoiceParticipants
          participants={participants}
          lookup={lookup}
          speaking={undefined}
          size={24}
          watch={{
            canConnect: true,
            onWatch: (userId) =>
              void watchStream(
                {
                  channelId: channel.id,
                  guildId: null,
                  channelName: me ? dmTitle(channel, me.id) : "Chamada",
                  canSpeak: true,
                },
                userId,
              ),
          }}
          className="px-3 pb-2"
        />
      )}
    </section>
  );
}
