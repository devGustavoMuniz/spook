import { Permission } from "@spook/shared";
import { Link, Navigate, Outlet, useParams, useSearch } from "@tanstack/react-router";
import { Hash } from "lucide-react";
import { useEffect } from "react";
import { Notice } from "@/components/notice";
import { MembersToggle, NavToggle } from "@/components/shell";
import { ChannelSidebar } from "@/features/channels/channel-sidebar";
import { useGuild } from "@/features/guilds/use-guild";
import { MemberUiProvider } from "@/features/members/member-ui";
import { MembersPanel } from "@/features/members/members-panel";
import { ChannelView } from "@/features/messages/channel-view";
import { PinnedMessagesButton } from "@/features/messages/pins-panel";
import { VoiceChannelView } from "@/features/voice/voice-channel-view";
import { appMessage } from "@/lib/app-errors";
import { CHANNEL_TEXT, CHANNEL_VOICE, can, channelsOf } from "@/lib/guild";
import { lastLocation } from "@/lib/last-location";

/** `/channels/$guildId`: barra de canais + conteúdo + membros. */
export function GuildLayout() {
  const { guildId } = useParams({ strict: false }) as { guildId: string };
  const { guild, isPending, isError, error } = useGuild(guildId);

  useEffect(() => {
    if (guild) lastLocation.remember(guild.id);
  }, [guild]);

  if (isPending)
    return (
      <output className="block p-6 text-sm text-muted-foreground">Carregando servidor…</output>
    );
  if (isError) return <Notice title="Não foi possível carregar">{appMessage(error)}</Notice>;
  if (!guild)
    return (
      <Notice title="Servidor não encontrado">
        Ele pode ter sido excluído, ou você não faz parte dele.{" "}
        <Link to="/" className="text-primary underline">
          Voltar ao início
        </Link>
      </Notice>
    );

  return (
    <MemberUiProvider guild={guild}>
      <div className="flex h-full">
        <ChannelSidebar guild={guild} />
        <div className="flex min-w-0 flex-1 flex-col">
          <Outlet />
        </div>
        <MembersPanel guild={guild} />
      </div>
    </MemberUiProvider>
  );
}

/** `/channels/$guildId` sem canal: abre o último canal de texto visitado ou o primeiro. */
export function GuildIndex() {
  const { guildId } = useParams({ strict: false }) as { guildId: string };
  const { guild } = useGuild(guildId);
  if (!guild) return null;
  const texts = channelsOf(guild).filter((c) => c.type === CHANNEL_TEXT);
  const target = texts.find((c) => c.id === lastLocation.channel(guildId)) ?? texts[0];
  if (target)
    return (
      <Navigate
        to="/channels/$guildId/$channelId"
        params={{ guildId, channelId: target.id }}
        replace
      />
    );
  return (
    <Notice title="Nenhum canal de texto">
      Quando houver um canal de texto que você possa ver, ele aparece aqui.
    </Notice>
  );
}

export function ChannelPage() {
  const { guildId, channelId } = useParams({ strict: false }) as {
    guildId: string;
    channelId: string;
  };
  const { perf } = useSearch({ strict: false }) as { perf?: number };
  const { guild } = useGuild(guildId);
  const channel = guild ? channelsOf(guild).find((c) => c.id === channelId) : undefined;

  useEffect(() => {
    if (channel?.type === CHANNEL_TEXT) lastLocation.remember(guildId, channel.id);
  }, [guildId, channel]);

  if (!guild) return null;
  if (!channel)
    return (
      <Notice title="Canal não encontrado">
        Ele pode ter sido excluído.{" "}
        <Link to="/channels/$guildId" params={{ guildId }} className="text-primary underline">
          Escolher outro canal
        </Link>
      </Notice>
    );
  if (channel.type === CHANNEL_VOICE) return <VoiceChannelView guild={guild} channel={channel} />;
  if (channel.type !== CHANNEL_TEXT) return <Notice title={channel.name} />;

  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <NavToggle />
        <Hash className="size-5 shrink-0 text-muted-foreground" aria-hidden />
        <h1 className="truncate font-semibold">{channel.name}</h1>
        <div className="ml-auto flex items-center gap-1">
          <PinnedMessagesButton
            channelId={channel.id}
            canUnpin={can(guild, Permission.MANAGE_MESSAGES)}
          />
          <MembersToggle />
        </div>
      </header>
      <ChannelView guild={guild} channelId={channel.id} channelName={channel.name} perf={perf} />
    </>
  );
}
