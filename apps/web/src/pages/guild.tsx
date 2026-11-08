import { Permission } from "@spook/shared";
import { Link, Navigate, Outlet, useParams, useSearch } from "@tanstack/react-router";
import { ArrowLeft, Hash } from "lucide-react";
import { useEffect } from "react";
import { MembersToggle, NavToggle } from "@/components/shell";
import { ErrorState, HomeButton, StateScreen } from "@/components/state-screen";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ChannelSidebar } from "@/features/channels/channel-sidebar";
import { ChannelTopic } from "@/features/channels/channel-topic";
import { useGuild } from "@/features/guilds/use-guild";
import { MemberUiProvider } from "@/features/members/member-ui";
import { MembersPanel } from "@/features/members/members-panel";
import { ChannelView } from "@/features/messages/channel-view";
import { PinnedMessagesButton } from "@/features/messages/pins-panel";
import { VoiceChannelView } from "@/features/voice/voice-channel-view";
import { useT } from "@/i18n";
import { CHANNEL_TEXT, CHANNEL_VOICE, can, channelsOf } from "@/lib/guild";
import { lastLocation } from "@/lib/last-location";

/** `/channels/$guildId`: barra de canais + conteúdo + membros. */
export function GuildLayout() {
  const { t } = useT();
  const { guildId } = useParams({ strict: false }) as { guildId: string };
  const { guild, isPending, isError, error, refetch, isFetching } = useGuild(guildId);

  useEffect(() => {
    if (guild) lastLocation.remember(guild.id);
  }, [guild]);

  if (isPending)
    return (
      <output className="flex h-full flex-col gap-3 p-6">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-72" />
        <span className="sr-only">{t("shell.guild.loading")}</span>
      </output>
    );
  if (isError)
    return <ErrorState error={error} onRetry={() => void refetch()} retrying={isFetching} />;
  if (!guild)
    return (
      <StateScreen
        title={t("shell.guild.notFoundTitle")}
        description={t("shell.guild.notFoundBody")}
        actions={<HomeButton />}
      />
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
  const { t } = useT();
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
        search={((prev: Record<string, unknown>) => prev) as never}
        replace
      />
    );
  return (
    <StateScreen title={t("shell.guild.noTextTitle")} description={t("shell.guild.noTextBody")} />
  );
}

export function ChannelPage() {
  const { t } = useT();
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
      <StateScreen
        title={t("shell.guild.channelNotFoundTitle")}
        description={t("shell.guild.channelNotFoundBody")}
        actions={
          <Button asChild>
            <Link to="/channels/$guildId" params={{ guildId }}>
              <ArrowLeft /> {t("shell.guild.pickChannel")}
            </Link>
          </Button>
        }
      />
    );
  if (channel.type === CHANNEL_VOICE) return <VoiceChannelView guild={guild} channel={channel} />;
  if (channel.type !== CHANNEL_TEXT) return <StateScreen title={channel.name} />;

  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <NavToggle />
        <Hash className="size-5 shrink-0 text-muted-foreground" aria-hidden />
        <h1 className="max-w-[45%] shrink-0 truncate font-semibold">{channel.name}</h1>
        <ChannelTopic name={channel.name} topic={channel.topic} />
        <div className="ml-auto flex shrink-0 items-center gap-1">
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
