import { type ChannelPayload, Permission, useGetMe, useReorderChannels } from "@spook/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  BellOff,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Hash,
  MoreVertical,
  Pencil,
  Plus,
  ShieldCheck,
  Trash2,
  Volume2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ShellSidebar } from "@/components/shell";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { GuildMenu } from "@/features/guilds/guild-menu";
import { MentionBadge, mentionLabel, UnreadDot } from "@/features/notifications/badges";
import { NotificationMenuItems } from "@/features/notifications/notification-menu";
import { useReadStateStore } from "@/features/notifications/read-state";
import { effective, useNotificationSettings } from "@/features/notifications/settings";
import { UserPanel } from "@/features/presence/user-panel";
import { joinVoice, prewarmVoice, watchStream } from "@/features/voice/controller";
import { voicePermissions } from "@/features/voice/permissions";
import { withProvisionalSelf } from "@/features/voice/provisional";
import { participantsOf, useVoiceStatesStore, useVoiceStore } from "@/features/voice/store";
import { usePersonLookup } from "@/features/voice/use-person-lookup";
import { VoiceParticipants } from "@/features/voice/voice-participants";
import { useT } from "@/i18n";
import { appMessage } from "@/lib/app-errors";
import {
  CHANNEL_CATEGORY,
  CHANNEL_TEXT,
  CHANNEL_VOICE,
  can,
  type Guild,
  groupChannels,
  moveChannel,
} from "@/lib/guild";
import { refreshGuilds } from "@/lib/guild-cache";
import { cn } from "@/lib/utils";
import { CreateChannelDialog, DeleteChannelDialog, RenameChannelDialog } from "./channel-dialogs";
import { ChannelPermissionsDialog } from "./permissions-dialog";

const collapsedKey = (guildId: string) => `spook:collapsed-categories:${guildId}`;

/** Categorias recolhidas de um servidor, guardadas por servidor no navegador (sem storage, só na sessão). */
export function useCollapsedCategories(guildId: string) {
  const [ids, setIds] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(collapsedKey(guildId));
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  });
  // outro servidor: lê o estado dele
  useEffect(() => {
    try {
      const raw = localStorage.getItem(collapsedKey(guildId));
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      setIds(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []);
    } catch {
      setIds([]);
    }
  }, [guildId]);
  function toggle(categoryId: string) {
    setIds((cur) => {
      const next = cur.includes(categoryId)
        ? cur.filter((x) => x !== categoryId)
        : [...cur, categoryId];
      try {
        localStorage.setItem(collapsedKey(guildId), JSON.stringify(next));
      } catch {
        /* sem storage: vale só nesta sessão */
      }
      return next;
    });
  }
  return { collapsed: new Set(ids), toggle };
}

export function ChannelSidebar({ guild }: { guild: Guild }) {
  const { t } = useT();
  const qc = useQueryClient();
  const params = useParams({ strict: false }) as { channelId?: string };
  const reorder = useReorderChannels();
  const reads = useReadStateStore((s) => s.channels);
  const settings = useNotificationSettings((s) => s.entries);
  useNotificationSettings((s) => s.tick); // reavalia quando um silêncio vence
  const canManage = can(guild, Permission.MANAGE_CHANNELS);
  const groups = groupChannels(guild);
  const navigate = useNavigate();
  const voiceStates = useVoiceStatesStore((s) => s.byUser);
  const myChannelId = useVoiceStore((s) => s.channelId);
  const myStatus = useVoiceStore((s) => s.status);
  const speaking = useVoiceStore((s) => s.speaking);
  const selfMute = useVoiceStore((s) => s.selfMute);
  const selfDeaf = useVoiceStore((s) => s.selfDeaf);
  const mine = { channelId: myChannelId, status: myStatus, speaking, selfMute, selfDeaf };
  const { data: me } = useGetMe();
  const perms = voicePermissions(guild);
  const anyoneInVoice = Object.values(voiceStates).some((v) => v.guild_id === guild.id);
  const lookup = usePersonLookup({ guildId: guild.id }, anyoneInVoice);

  /** Clique no canal de voz: entra (ou troca de canal) e abre o painel do canal. */
  function enterVoice(c: ChannelPayload) {
    void navigate({
      to: "/channels/$guildId/$channelId",
      params: { guildId: guild.id, channelId: c.id },
    });
    void joinVoice({
      channelId: c.id,
      guildId: guild.id,
      channelName: c.name,
      canSpeak: perms.speak,
    });
  }
  const [scrolled, setScrolled] = useState(false);
  const { collapsed, toggle: toggleCategory } = useCollapsedCategories(guild.id);
  const [creating, setCreating] = useState<{ parentId?: string } | null>(null);
  const [renaming, setRenaming] = useState<ChannelPayload | null>(null);
  const [deleting, setDeleting] = useState<ChannelPayload | null>(null);
  const [permsFor, setPermsFor] = useState<ChannelPayload | null>(null);

  async function move(channel: ChannelPayload, dir: -1 | 1) {
    const channels = moveChannel(guild, channel.id, dir);
    if (!channels) return;
    try {
      await reorder.mutateAsync({ guildId: guild.id, data: { channels } });
      await refreshGuilds(qc);
    } catch (e) {
      toast.error(appMessage(e));
    }
  }

  function renderMenu(c: ChannelPayload) {
    const notifiable = c.type === CHANNEL_TEXT;
    if (!canManage && !notifiable) return null;
    const canUp = moveChannel(guild, c.id, -1) !== null;
    const canDown = moveChannel(guild, c.id, 1) !== null;
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
            aria-label={t("channels.sidebar.optionsAria", { name: c.name })}
          >
            <MoreVertical />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {notifiable ? (
            <NotificationMenuItems
              scope="channel"
              targetId={c.id}
              what={t("channels.sidebar.notifyThis")}
              isGuildLike
              withSeparator={false}
            />
          ) : null}
          {canManage ? (
            <>
              {notifiable ? <DropdownMenuSeparator /> : null}
              <DropdownMenuItem onSelect={() => setRenaming(c)}>
                <Pencil />{" "}
                {c.type === CHANNEL_CATEGORY
                  ? t("channels.sidebar.rename")
                  : t("channels.sidebar.edit")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setPermsFor(c)}>
                <ShieldCheck /> {t("channels.sidebar.permissions")}
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!canUp} onSelect={() => void move(c, -1)}>
                <ChevronUp /> {t("channels.sidebar.moveUp")}
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!canDown} onSelect={() => void move(c, 1)}>
                <ChevronDown /> {t("channels.sidebar.moveDown")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive onSelect={() => setDeleting(c)}>
                <Trash2 /> {t("channels.sidebar.delete")}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  const isUnread = (id: string) => {
    const r = reads[id];
    return !!r && (r.unread > 0 || r.mentions > 0);
  };

  function renderChannel(c: ChannelPayload) {
    const active = c.id === params.channelId;
    const read = reads[c.id];
    const unread = isUnread(c.id);
    const muted = effective(settings, { guildId: guild.id, channelId: c.id }).muted;
    const joined = c.type === CHANNEL_VOICE && mine.channelId === c.id && mine.status !== "idle";
    const rowClass = cn(
      "group relative flex items-center rounded-md transition-colors",
      active ? "bg-brand-500/15 hover:bg-brand-500/20" : "hover:bg-accent",
      muted && "opacity-60 hover:opacity-100",
    );
    const linkTone = active
      ? "font-medium text-foreground"
      : unread
        ? "font-semibold text-foreground"
        : "text-muted-foreground hover:text-foreground";
    return (
      <li key={c.id}>
        <div className={rowClass} data-muted={muted || undefined} data-active={active || undefined}>
          {unread && !active && !muted ? (
            <span
              aria-hidden
              className="absolute top-1/2 -left-2 h-2 w-1 -translate-y-1/2 rounded-r-full bg-foreground"
            />
          ) : null}
          {c.type === CHANNEL_VOICE ? (
            <button
              type="button"
              disabled={!perms.connect}
              onClick={() => enterVoice(c)}
              onPointerEnter={prewarmVoice}
              onFocus={prewarmVoice}
              title={
                perms.connect ? t("channels.sidebar.joinVoice") : t("channels.sidebar.noVoicePerm")
              }
              className={cn(
                "flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm disabled:cursor-not-allowed disabled:opacity-60",
                joined ? "font-medium text-success-text" : linkTone,
              )}
            >
              <Volume2 className="size-4 shrink-0" aria-hidden />
              <span className="truncate">{c.name}</span>
              <span className="sr-only">
                {perms.connect
                  ? t("channels.sidebar.voiceSr")
                  : t("channels.sidebar.voiceSrNoPerm")}
              </span>
            </button>
          ) : (
            <Link
              to="/channels/$guildId/$channelId"
              params={{ guildId: guild.id, channelId: c.id }}
              className={cn(
                "flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                linkTone,
              )}
            >
              <Hash className="size-4 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{c.name}</span>
              {muted ? (
                <BellOff
                  className="size-3.5 shrink-0"
                  aria-label={t("channels.sidebar.muted")}
                  role="img"
                />
              ) : null}
              {read && read.mentions > 0 ? (
                <MentionBadge
                  count={read.mentions}
                  label={mentionLabel(read.mentions, `#${c.name}`)}
                />
              ) : unread ? (
                <UnreadDot label={t("channels.sidebar.unreadIn", { name: c.name })} />
              ) : null}
            </Link>
          )}
          {renderMenu(c)}
        </div>
        {c.type === CHANNEL_VOICE ? (
          <VoiceParticipants
            participants={withProvisionalSelf(participantsOf(voiceStates, c.id), {
              meId: me?.id,
              channelId: c.id,
              guildId: guild.id,
              active: mine.channelId === c.id && mine.status !== "idle",
              selfMute: mine.selfMute,
              selfDeaf: mine.selfDeaf,
            })}
            lookup={lookup}
            speaking={mine.channelId === c.id ? mine.speaking : undefined}
            watch={{
              canConnect: perms.connect || (mine.channelId === c.id && mine.status !== "idle"),
              onWatch: (userId) => {
                void navigate({
                  to: "/channels/$guildId/$channelId",
                  params: { guildId: guild.id, channelId: c.id },
                });
                void watchStream(
                  {
                    channelId: c.id,
                    guildId: guild.id,
                    channelName: c.name,
                    canSpeak: perms.speak,
                  },
                  userId,
                );
              },
            }}
            className="mt-0.5 mb-1 ml-5 border-l pl-1"
          />
        ) : null}
      </li>
    );
  }

  /** Categoria recolhida só esconde o que está "quieto": o canal aberto, os com novidades e a voz com gente continuam. */
  const visibleChildren = (categoryId: string, children: ChannelPayload[]) =>
    collapsed.has(categoryId)
      ? children.filter(
          (c) =>
            c.id === params.channelId ||
            isUnread(c.id) ||
            (c.type === CHANNEL_VOICE &&
              (participantsOf(voiceStates, c.id).length > 0 ||
                (mine.channelId === c.id && mine.status !== "idle"))),
        )
      : children;

  return (
    <ShellSidebar>
      <div className="flex w-60 shrink-0 flex-col border-r bg-sidebar">
        <GuildMenu guild={guild} onCreateChannel={() => setCreating({})} elevated={scrolled} />
        <nav
          aria-label={t("channels.sidebar.nav")}
          onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 2)}
          className="min-h-0 flex-1 overflow-y-auto px-2 py-2"
        >
          {groups.loose.length === 0 && groups.categories.length === 0 ? (
            <p className="px-2 text-sm text-muted-foreground">{t("channels.sidebar.none")}</p>
          ) : null}
          <ul className="flex flex-col gap-0.5">{groups.loose.map(renderChannel)}</ul>
          {groups.categories.map(({ category, children }) => {
            const isCollapsed = collapsed.has(category.id);
            return (
              <section
                key={category.id}
                aria-label={t("channels.sidebar.categoryAria", { name: category.name })}
                className="mt-4"
              >
                <div className="group flex items-center gap-0.5">
                  <h3 className="min-w-0 flex-1">
                    <button
                      type="button"
                      aria-expanded={!isCollapsed}
                      onClick={() => toggleCategory(category.id)}
                      className="flex w-full items-center gap-1 rounded-md px-1 py-1 text-left text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <ChevronRight
                        aria-hidden
                        className={cn(
                          "size-3.5 shrink-0 transition-transform duration-[var(--dur-base)]",
                          !isCollapsed && "rotate-90",
                        )}
                      />
                      <span className="truncate">{category.name}</span>
                    </button>
                  </h3>
                  {canManage ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-6 text-muted-foreground"
                          aria-label={t("channels.sidebar.createIn", { name: category.name })}
                          onClick={() => setCreating({ parentId: category.id })}
                        >
                          <Plus />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        {t("channels.sidebar.createIn", { name: category.name })}
                      </TooltipContent>
                    </Tooltip>
                  ) : null}
                  {renderMenu(category)}
                </div>
                <ul className="mt-0.5 flex flex-col gap-0.5">
                  {visibleChildren(category.id, children).map(renderChannel)}
                </ul>
              </section>
            );
          })}
        </nav>
        <UserPanel />
        {canManage ? (
          <CreateChannelDialog
            guild={guild}
            open={creating !== null}
            onOpenChange={(o) => !o && setCreating(null)}
            parentId={creating?.parentId}
          />
        ) : null}
        <RenameChannelDialog channel={renaming} onClose={() => setRenaming(null)} />
        {canManage ? (
          <ChannelPermissionsDialog
            guild={guild}
            channel={permsFor}
            onClose={() => setPermsFor(null)}
          />
        ) : null}
        <DeleteChannelDialog
          guild={guild}
          channel={deleting}
          activeChannelId={params.channelId}
          onClose={() => setDeleting(null)}
        />
      </div>
    </ShellSidebar>
  );
}
