import { type ChannelPayload, useGetMe } from "@spook/shared";
import { Link } from "@tanstack/react-router";
import { Plus, Users } from "lucide-react";
import { useState } from "react";
import { StatusAvatar } from "@/components/presence-dot";
import { Button } from "@/components/ui/button";
import { appMessage } from "@/lib/app-errors";
import { dmTitle, isGroupDm, otherRecipient } from "./dm-utils";
import { NewGroupDialog } from "./new-group-dialog";
import { useDmUnreadStore } from "./unread-store";
import { useDms } from "./use-dms";

/** Lista de conversas (1:1 e em grupo) por atividade recente, com o botão de nova conversa em grupo. */
export function DmSidebar() {
  const { data: me } = useGetMe();
  const dms = useDms();
  const [creating, setCreating] = useState(false);
  return (
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
      <NewGroupDialog open={creating} onOpenChange={setCreating} />
    </aside>
  );
}

function DmItem({ channel, myId }: { channel: ChannelPayload; myId: string }) {
  const unread = useDmUnreadStore((s) => s.channels.has(channel.id));
  const title = dmTitle(channel, myId);
  const other = otherRecipient(channel, myId);
  return (
    <Link
      to="/channels/@me/$channelId"
      params={{ channelId: channel.id }}
      className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm hover:bg-accent data-[status=active]:bg-accent"
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
        className={unread ? "min-w-0 flex-1 truncate font-semibold" : "min-w-0 flex-1 truncate"}
      >
        {title}
      </span>
      {unread ? (
        <span
          role="img"
          aria-label="Mensagens novas"
          className="size-2 shrink-0 rounded-full bg-primary"
        />
      ) : null}
    </Link>
  );
}
