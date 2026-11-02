import type { ChannelPayload } from "@spook/shared";
import { Phone, Volume2 } from "lucide-react";
import { Notice } from "@/components/notice";
import { NavToggle } from "@/components/shell";
import { Button } from "@/components/ui/button";
import type { Guild } from "@/lib/guild";
import { useCallParticipants } from "./call-panel";
import { joinVoice, leaveCall } from "./controller";
import { voicePermissions } from "./permissions";
import { useVoiceStore } from "./store";
import { usePersonLookup } from "./use-person-lookup";
import { VideoGrid } from "./video-grid";
import { VoiceParticipants } from "./voice-participants";

/** Conteúdo de um canal de voz de servidor: vídeo/tela, quem está conectado e entrar/sair. */
export function VoiceChannelView({ guild, channel }: { guild: Guild; channel: ChannelPayload }) {
  const inThis = useVoiceStore((s) => s.channelId === channel.id && s.status !== "idle");
  const connecting = useVoiceStore((s) => s.channelId === channel.id && s.status === "connecting");
  const speaking = useVoiceStore((s) => s.speaking);
  const participants = useCallParticipants(channel.id);
  const perms = voicePermissions(guild);
  const lookup = usePersonLookup({ guildId: guild.id }, participants.length > 0);

  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <NavToggle />
        <Volume2 className="size-5 text-muted-foreground" aria-hidden />
        <h1 className="truncate font-semibold">{channel.name}</h1>
        <div className="ml-auto">
          {inThis ? (
            <Button variant="destructive" size="sm" onClick={() => void leaveCall()}>
              Sair do canal
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={!perms.connect || connecting}
              title={perms.connect ? undefined : "Você não tem permissão para entrar neste canal."}
              onClick={() =>
                void joinVoice({
                  channelId: channel.id,
                  guildId: guild.id,
                  channelName: channel.name,
                  canSpeak: perms.speak,
                })
              }
            >
              <Phone /> Entrar no canal
            </Button>
          )}
        </div>
      </header>
      {!perms.connect ? (
        <p className="border-b bg-muted/40 px-4 py-2 text-sm text-muted-foreground">
          Você não tem permissão para entrar neste canal de voz.
        </p>
      ) : inThis && !perms.speak ? (
        <p className="border-b bg-muted/40 px-4 py-2 text-sm text-muted-foreground">
          Você pode ouvir, mas não tem permissão para falar neste canal.
        </p>
      ) : null}
      {inThis ? <VideoGrid lookup={lookup} /> : null}
      {participants.length === 0 && !inThis ? (
        <Notice title="Ninguém por aqui">Entre no canal para começar uma conversa por voz.</Notice>
      ) : (
        <div className="p-4">
          <h2 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Conectados ({participants.length})
          </h2>
          <VoiceParticipants
            participants={participants}
            lookup={lookup}
            speaking={inThis ? speaking : undefined}
            size={32}
          />
        </div>
      )}
    </>
  );
}
