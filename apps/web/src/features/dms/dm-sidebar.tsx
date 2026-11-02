import { type ChannelPayload, useGetMe } from "@spook/shared";
import { Link } from "@tanstack/react-router";
import { BellOff, MoreVertical, Plus, Users } from "lucide-react";
import { useState } from "react";
import { StatusAvatar } from "@/components/presence-dot";
import { ShellSidebar } from "@/components/shell";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MentionBadge, UnreadDot, useChannelRead } from "@/features/notifications/badges";
import { NotificationMenuItems } from "@/features/notifications/notification-menu";
import { useIsMuted } from "@/features/notifications/settings";
import { UserPanel } from "@/features/presence/user-panel";
import { appMessage } from "@/lib/app-errors";
import { dmTitle, isGroupDm, otherRecipient } from "./dm-utils";
import { NewGroupDialog } from "./new-group-dialog";
import { useDms } from "./use-dms";

/** Lista de conversas (1:1 e em grupo) por atividade recente, com o botão de nova conversa em grupo. */
export function DmSidebar() {
  const { data: me } = useGetMe();
  const dms = useDms();
  const [creating, setCreating] = useState(false);
  return (
    <ShellSidebar>
      <aside
        aria-label="Mensagens diretas"
        className="flex w-60 shrink-0 flex-col border-r bg-sidebar"
      >
        <div className="flex h-12 shrink-0 items-center justify-between border-b px-4">
          <h2 className="text-sm font-semibold">Mensagens diretas</h2>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Nova conversa em grupo"
            onClick={() => setCreating(true)}
          >
            <Plus />
          </Button>
        </div>
        <nav aria-label="Conversas" className="min-h-0 flex-1 overflow-y-auto p-2">
          {dms.isPending ? (
            <p className="px-2 text-sm text-muted-foreground">Carregando conversas…</p>
          ) : dms.isError ? (
            <p className="px-2 text-sm text-destructive-text">{appMessage(dms.error)}</p>
          ) : dms.list.length === 0 ? (
            <p className="px-2 text-sm text-muted-foreground">
              Nenhuma conversa ainda. Abra o menu de um membro e escolha "Enviar mensagem".
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {me
                ? dms.list.map((c) => (
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
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground data-[status=active]:bg-brand-500/15 data-[status=active]:font-medium data-[status=active]:text-foreground"
      >
        {isGroupDm(channel) ? (
          <span
            aria-hidden
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary text-secondary-foreground"
          >
            <Users className="size-4" />
          </span>
        ) : (
          <StatusAvatar userId={other?.id} url={other?.avatar_url} name={title} size={32} />
        )}
        <span
          className={
            unread
              ? "min-w-0 flex-1 truncate font-semibold text-foreground"
              : "min-w-0 flex-1 truncate"
          }
        >
          {title}
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
        ) : null}
      </Link>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 shrink-0 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
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
