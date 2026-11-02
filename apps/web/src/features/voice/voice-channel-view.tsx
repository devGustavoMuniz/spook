import type { ChannelPayload } from "@spook/shared";
import { Phone, Volume2 } from "lucide-react";
import { EmptyChatIllustration, VoiceInviteIllustration } from "@/components/illustrations";
import { NavToggle } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import type { Guild } from "@/lib/guild";
import { useStageParticipants } from "./call-panel";
import { joinVoice } from "./controller";
import { voicePermissions } from "./permissions";
import { VoiceStage } from "./stage/voice-stage";
import { useVoiceAvailabilityStore, useVoiceStore } from "./store";
import { usePersonLookup } from "./use-person-lookup";
import { QualityIndicator } from "./voice-bar";

/** Canal de voz de servidor: cabeçalho enxuto e o palco (grade de tiles, controles flutuantes). */
export function VoiceChannelView({ guild, channel }: { guild: Guild; channel: ChannelPayload }) {
  const inThis = useVoiceStore((s) => s.channelId === channel.id && s.status !== "idle");
  const connecting = useVoiceStore((s) => s.channelId === channel.id && s.status === "connecting");
  const live = useVoiceStore((s) => s.channelId === channel.id && s.status === "connected");
  const quality = useVoiceStore((s) => s.quality);
  const unavailable = useVoiceAvailabilityStore((s) => s.unavailable);
  const participants = useStageParticipants(channel.id, guild.id, inThis);
  const perms = voicePermissions(guild);
  const lookup = usePersonLookup({ guildId: guild.id }, participants.length > 0);
  const count = participants.length;

  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <NavToggle />
        <Volume2 className="size-5 shrink-0 text-muted-foreground" aria-hidden />
        <h1 className="truncate font-semibold">{channel.name}</h1>
        <span className="shrink-0 text-sm text-muted-foreground">
          {count === 0 ? "Ninguém conectado" : `${count} ${count === 1 ? "pessoa" : "pessoas"}`}
        </span>
        <div className="ml-auto flex items-center gap-3">
          {live ? <QualityIndicator quality={quality} /> : null}
          {inThis ? null : (
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
      {unavailable && !inThis ? (
        <EmptyState
          illustration={<EmptyChatIllustration className="w-44" />}
          title="Voz indisponível"
          description="Este servidor do Spook ainda não tem o serviço de voz ligado. Quando o administrador o configurar, é só entrar de novo."
        />
      ) : participants.length === 0 && !inThis ? (
        <EmptyState
          illustration={<VoiceInviteIllustration className="w-44" />}
          title="Ninguém por aqui"
          description="Entre no canal para começar uma conversa por voz."
        />
      ) : (
        <VoiceStage participants={participants} lookup={lookup} inCall={inThis} guild={guild} />
      )}
    </>
  );
}
