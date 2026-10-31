import { type ChannelPayload, useGetMe } from "@spook/shared";
import { Phone, PhoneOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { dmTitle } from "@/features/dms/dm-utils";
import { joinVoice, leaveCall } from "./controller";
import { participantsOf, useVoiceStatesStore, useVoiceStore } from "./store";
import { usePersonLookup } from "./use-person-lookup";
import { VideoGrid } from "./video-grid";
import { VoiceParticipants } from "./voice-participants";

/** Quantas pessoas estão na chamada do canal (DM ou canal de voz). */
export function useCallParticipants(channelId: string) {
  const byUser = useVoiceStatesStore((s) => s.byUser);
  return participantsOf(byUser, channelId);
}

/** Botão de chamada no cabeçalho da DM (mesmo fluxo do canal de voz; sala = ID da DM). */
export function DmCallButton({ channel }: { channel: ChannelPayload }) {
  const { data: me } = useGetMe();
  const inThis = useVoiceStore((s) => s.channelId === channel.id && s.status !== "idle");
  const connecting = useVoiceStore((s) => s.status === "connecting");
  const participants = useCallParticipants(channel.id);
  if (!me) return null;
  const ongoing = participants.length > 0;

  if (inThis)
    return (
      <Button variant="destructive" size="sm" onClick={() => void leaveCall()}>
        <PhoneOff /> Sair da chamada
      </Button>
    );
  return (
    <Button
      variant={ongoing ? "default" : "outline"}
      size="sm"
      disabled={connecting}
      onClick={() =>
        void joinVoice({
          channelId: channel.id,
          guildId: null,
          channelName: dmTitle(channel, me.id),
          canSpeak: true,
        })
      }
    >
      <Phone /> {ongoing ? "Entrar na chamada" : "Ligar"}
    </Button>
  );
}

/** Faixa no topo da DM: chamada em andamento (quem está nela) e, se estou nela, o vídeo. */
export function DmCallPanel({ channel }: { channel: ChannelPayload }) {
  const participants = useCallParticipants(channel.id);
  const inThis = useVoiceStore((s) => s.channelId === channel.id && s.status !== "idle");
  const speaking = useVoiceStore((s) => s.speaking);
  const hasVideo = useVoiceStore((s) => s.videoTracks.length > 0);
  const lookup = usePersonLookup({ guildId: null, dmId: channel.id });
  if (participants.length === 0 && !inThis) return null;
  return (
    <section
      aria-label="Chamada em andamento"
      className={`flex flex-col border-b bg-muted/40 ${inThis && hasVideo ? "h-[55%] min-h-48" : ""}`}
    >
      <div className="flex items-center gap-2 px-4 py-2 text-sm">
        <span className="size-2 rounded-full bg-emerald-500" aria-hidden />
        <span className="font-medium">Chamada em andamento</span>
        <span className="text-muted-foreground">
          {participants.length} {participants.length === 1 ? "pessoa" : "pessoas"}
        </span>
      </div>
      {inThis ? <VideoGrid lookup={lookup} /> : null}
      <VoiceParticipants
        participants={participants}
        lookup={lookup}
        speaking={inThis ? speaking : undefined}
        size={24}
        className="px-3 pb-2"
      />
    </section>
  );
}
