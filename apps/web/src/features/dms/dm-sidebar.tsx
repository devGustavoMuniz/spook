import { type ChannelPayload, useGetMe } from "@spook/shared";
import { Link } from "@tanstack/react-router";
import { BellOff, MessageSquarePlus, MoreVertical, Search, SearchX, Users } from "lucide-react";
import { useState } from "react";
import { EmptyChatIllustration } from "@/components/illustrations";
import { StatusAvatar } from "@/components/presence-dot";
import { ShellSidebar } from "@/components/shell";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { MentionBadge, UnreadDot, useChannelRead } from "@/features/notifications/badges";
import { NotificationMenuItems } from "@/features/notifications/notification-menu";
import { useIsMuted } from "@/features/notifications/settings";
import { UserPanel } from "@/features/presence/user-panel";
import { appMessage } from "@/lib/app-errors";
import { shortListTime, snowflakeTime } from "@/lib/snowflake-time";
import { dmTitle, isGroupDm, otherRecipient, recipientsOf } from "./dm-utils";
import { NewGroupDialog } from "./new-group-dialog";
import { useDms } from "./use-dms";

/** Lista de conversas (1:1 e em grupo) por atividade recente, com busca e o botão de nova conversa. */
export function DmSidebar() {
  const { data: me } = useGetMe();
  const dms = useDms();
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const q = query.trim().toLocaleLowerCase("pt-BR");
  const shown =
    me && q
      ? dms.list.filter((c) => dmTitle(c, me.id).toLocaleLowerCase("pt-BR").includes(q))
      : dms.list;
  return (
    <ShellSidebar>
      <aside
        aria-label="Mensagens diretas"
        className="flex w-60 shrink-0 flex-col border-r bg-sidebar"
      >
        <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b px-4">
          <h2 className="text-sm font-semibold">Mensagens diretas</h2>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Nova conversa em grupo"
            title="Nova conversa"
            onClick={() => setCreating(true)}
          >
            <MessageSquarePlus />
          </Button>
        </div>
        {dms.list.length > 0 ? (
          <div className="relative shrink-0 px-2 pt-2">
            <Search
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-5 mt-1 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              type="search"
              size="sm"
              aria-label="Buscar conversas"
              placeholder="Buscar conversas"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-8"
            />
          </div>
        ) : null}
        <nav aria-label="Conversas" className="min-h-0 flex-1 overflow-y-auto p-2">
          {dms.isPending ? (
            <ul aria-hidden className="flex flex-col gap-1">
              {[0, 1, 2, 3].map((i) => (
                <li key={i} className="flex items-center gap-2.5 px-2 py-1.5">
                  <Skeleton className="size-9 rounded-full" />
                  <Skeleton className="h-4 flex-1" />
                </li>
              ))}
            </ul>
          ) : dms.isError ? (
            <div role="alert" className="flex flex-col items-start gap-2 px-2 text-sm">
              <p className="text-destructive-text">{appMessage(dms.error)}</p>
              <Button size="sm" variant="outline" onClick={() => void dms.refetch()}>
                Tentar de novo
              </Button>
            </div>
          ) : dms.list.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-3 py-6 text-center">
              <EmptyChatIllustration className="h-24 w-auto" />
              <p className="text-sm font-medium">Nenhuma conversa ainda</p>
              <p className="text-xs text-muted-foreground text-pretty">
                Abra o menu de um membro e escolha "Enviar mensagem".
              </p>
              <Button size="sm" variant="soft" onClick={() => setCreating(true)}>
                <MessageSquarePlus /> Nova conversa
              </Button>
            </div>
          ) : shown.length === 0 ? (
            <p className="flex flex-col items-center gap-1.5 px-3 py-6 text-center text-xs text-muted-foreground">
              <SearchX aria-hidden className="size-5" />
              Nenhuma conversa com "{query.trim()}".
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {me
                ? shown.map((c) => (
                    <li key={c.id}>
                      <DmItem channel={c} myId={me.id} />
                    </li>
                  ))
                : null}
            </ul>
          )}
        </nav>
        <UserPanel />
        <NewGroupDialog open={creating} onOpenChange={setCreating} />
      </aside>
    </ShellSidebar>
  );
}

function DmItem({ channel, myId }: { channel: ChannelPayload; myId: string }) {
  const read = useChannelRead(channel.id);
  const unread = !!read && (read.unread > 0 || read.mentions > 0);
  const title = dmTitle(channel, myId);
  const other = otherRecipient(channel, myId);
  const muted = useIsMuted("channel", channel.id);
  const last = snowflakeTime(channel.last_message_id);
  const group = isGroupDm(channel);
  return (
    <div
      className={`group relative flex items-center rounded-md transition-colors hover:bg-accent ${muted ? "opacity-60 hover:opacity-100" : ""}`}
      data-muted={muted || undefined}
    >
      {unread && !muted ? (
        <span
          aria-hidden
          className="absolute top-1/2 -left-2 h-2 w-1 -translate-y-1/2 rounded-r-full bg-foreground"
        />
      ) : null}
      <Link
        to="/channels/@me/$channelId"
        params={{ channelId: channel.id }}
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground data-[status=active]:bg-brand-500/15 data-[status=active]:font-medium data-[status=active]:text-foreground data-[status=active]:shadow-[inset_2px_0_0_var(--primary)]"
      >
        {group ? (
          <span
            aria-hidden
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary text-secondary-foreground"
          >
            <Users className="size-4" />
          </span>
        ) : (
          <StatusAvatar userId={other?.id} url={other?.avatar_url} name={title} size={36} />
        )}
        <span className="flex min-w-0 flex-1 flex-col">
          <span
            data-dm-title
            className={
              unread ? "truncate font-semibold text-foreground" : "truncate text-foreground/90"
            }
          >
            {title}
          </span>
          {group ? (
            <span className="truncate text-xs">{recipientsOf(channel).length} participantes</span>
          ) : null}
        </span>
        {muted ? (
          <BellOff className="size-3.5 shrink-0" aria-label="Silenciado" role="img" />
        ) : null}
        {read && read.mentions > 0 ? (
          <MentionBadge
            count={read.mentions}
            label={`${read.mentions > 99 ? "99+" : read.mentions} mensagens novas`}
          />
        ) : unread ? (
          <UnreadDot label="Mensagens novas" />
        ) : last ? (
          <time
            dateTime={last.toISOString()}
            title="Última mensagem"
            className="shrink-0 text-2xs text-muted-foreground group-focus-within:hidden group-hover:hidden"
          >
            {shortListTime(last)}
          </time>
        ) : null}
      </Link>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="absolute top-1/2 right-1 -translate-y-1/2 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
            aria-label={`Opções de ${title}`}
          >
            <MoreVertical />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <NotificationMenuItems
            scope="channel"
            targetId={channel.id}
            what="esta conversa"
            isGuildLike={false}
            withSeparator={false}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
