import { type ChannelPayload, Permission, useGetMe, useReorderChannels } from "@spook/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import {
  ChevronDown,
  ChevronUp,
  Hash,
  MoreVertical,
  Pencil,
  Plus,
  Trash2,
  Volume2,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Avatar } from "@/components/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { GuildMenu } from "@/features/guilds/guild-menu";
import { appMessage } from "@/lib/app-errors";
import { CHANNEL_VOICE, can, type Guild, groupChannels, moveChannel } from "@/lib/guild";
import { refreshGuilds } from "@/lib/guild-cache";
import { CreateChannelDialog, DeleteChannelDialog, RenameChannelDialog } from "./channel-dialogs";

export function ChannelSidebar({ guild }: { guild: Guild }) {
  const qc = useQueryClient();
  const params = useParams({ strict: false }) as { channelId?: string };
  const reorder = useReorderChannels();
  const canManage = can(guild, Permission.MANAGE_CHANNELS);
  const groups = groupChannels(guild);
  const [creating, setCreating] = useState<{ parentId?: string } | null>(null);
  const [renaming, setRenaming] = useState<ChannelPayload | null>(null);
  const [deleting, setDeleting] = useState<ChannelPayload | null>(null);

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
    if (!canManage) return null;
    const canUp = moveChannel(guild, c.id, -1) !== null;
    const canDown = moveChannel(guild, c.id, 1) !== null;
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
            aria-label={`Opções de ${c.name}`}
          >
            <MoreVertical />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setRenaming(c)}>
            <Pencil /> Renomear
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!canUp} onSelect={() => void move(c, -1)}>
            <ChevronUp /> Mover para cima
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!canDown} onSelect={() => void move(c, 1)}>
            <ChevronDown /> Mover para baixo
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem destructive onSelect={() => setDeleting(c)}>
            <Trash2 /> Excluir
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  function renderChannel(c: ChannelPayload) {
    const active = c.id === params.channelId;
    return (
      <li key={c.id} className="group flex items-center rounded-md hover:bg-accent">
        {c.type === CHANNEL_VOICE ? (
          <span
            className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground"
            title="Canais de voz ainda não estão disponíveis"
          >
            <Volume2 className="size-4 shrink-0" aria-hidden />
            <span className="truncate">{c.name}</span>
            <span className="sr-only">(canal de voz, indisponível)</span>
          </span>
        ) : (
          <Link
            to="/channels/$guildId/$channelId"
            params={{ guildId: guild.id, channelId: c.id }}
            className={`flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm ${
              active ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground"
            }`}
          >
            <Hash className="size-4 shrink-0" aria-hidden />
            <span className="truncate">{c.name}</span>
          </Link>
        )}
        {renderMenu(c)}
      </li>
    );
  }

  return (
    <div className="flex w-60 shrink-0 flex-col border-r bg-sidebar">
      <GuildMenu guild={guild} onCreateChannel={() => setCreating({})} />
      <nav aria-label="Canais" className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {groups.loose.length === 0 && groups.categories.length === 0 ? (
          <p className="px-2 text-sm text-muted-foreground">Nenhum canal por aqui.</p>
        ) : null}
        <ul className="flex flex-col gap-0.5">{groups.loose.map(renderChannel)}</ul>
        {groups.categories.map(({ category, children }) => (
          <section key={category.id} aria-label={`Categoria ${category.name}`} className="mt-3">
            <div className="group flex items-center gap-1 px-2">
              <h3 className="min-w-0 flex-1 truncate text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                {category.name}
              </h3>
              {canManage ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6"
                  aria-label={`Criar canal em ${category.name}`}
                  onClick={() => setCreating({ parentId: category.id })}
                >
                  <Plus />
                </Button>
              ) : null}
              {renderMenu(category)}
            </div>
            <ul className="mt-1 flex flex-col gap-0.5">{children.map(renderChannel)}</ul>
          </section>
        ))}
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
      <DeleteChannelDialog
        guild={guild}
        channel={deleting}
        activeChannelId={params.channelId}
        onClose={() => setDeleting(null)}
      />
    </div>
  );
}

function UserPanel() {
  const { data: me } = useGetMe();
  if (!me) return null;
  const name = me.display_name || me.username;
  return (
    <div className="flex items-center gap-2 border-t p-2">
      <Link
        to="/settings/profile"
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md p-1 hover:bg-accent"
        aria-label="Meu perfil"
      >
        <Avatar url={me.avatar_url} name={name} size={32} />
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">{name}</span>
          <span className="block truncate text-xs text-muted-foreground">@{me.username}</span>
        </span>
      </Link>
    </div>
  );
}
