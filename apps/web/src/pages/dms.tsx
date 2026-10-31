import { useGetMe } from "@spook/shared";
import { Link, Outlet, useParams } from "@tanstack/react-router";
import { MessageCircle, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { Notice } from "@/components/notice";
import { PresenceDot, StatusAvatar, statusLabel } from "@/components/presence-dot";
import { Button } from "@/components/ui/button";
import { DmSidebar } from "@/features/dms/dm-sidebar";
import { dmTitle, isGroupDm, otherRecipient, recipientsOf } from "@/features/dms/dm-utils";
import { GroupDialog } from "@/features/dms/group-dialog";
import { NewGroupDialog } from "@/features/dms/new-group-dialog";
import { useDmUnreadStore } from "@/features/dms/unread-store";
import { useDms } from "@/features/dms/use-dms";
import { ChannelView } from "@/features/messages/channel-view";
import { usePresence } from "@/features/presence/store";
import { DmCallButton, DmCallPanel } from "@/features/voice/call-panel";
import { appMessage } from "@/lib/app-errors";

/** `/channels/@me`: lista de conversas + a conversa aberta. */
export function DmLayout() {
  return (
    <div className="flex h-full">
      <DmSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Outlet />
      </div>
    </div>
  );
}

/** `/channels/@me` sem conversa escolhida. */
export function DmIndex() {
  const dms = useDms();
  const [creating, setCreating] = useState(false);
  if (dms.isPending) return null;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
      <MessageCircle className="size-12 text-muted-foreground" aria-hidden />
      <div>
        <h1 className="text-lg font-semibold">
          {dms.list.length === 0 ? "Você ainda não tem conversas" : "Escolha uma conversa"}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {dms.list.length === 0
            ? 'Abra o menu de um membro de um servidor e escolha "Enviar mensagem", ou crie uma conversa em grupo.'
            : "Selecione uma conversa na lista ou crie uma em grupo."}
        </p>
      </div>
      <Button variant="outline" onClick={() => setCreating(true)}>
        <Users /> Criar conversa em grupo
      </Button>
      <NewGroupDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}

/** `/channels/@me/$channelId`: cabeçalho da DM e o painel de mensagens. */
export function DmPage() {
  const { channelId } = useParams({ strict: false }) as { channelId: string };
  const { data: me } = useGetMe();
  const dms = useDms();
  const [managing, setManaging] = useState(false);
  const channel = dms.list.find((c) => c.id === channelId);

  // Abrir a conversa a marca como lida (só nesta sessão; a contagem de verdade é a Fase 6).
  const clearUnread = useDmUnreadStore((s) => s.clear);
  useEffect(() => clearUnread(channelId), [channelId, clearUnread]);

  if (dms.isPending || !me) return null;
  if (dms.isError)
    return <Notice title="Não foi possível carregar">{appMessage(dms.error)}</Notice>;
  if (!channel)
    return (
      <Notice title="Conversa não encontrada">
        Você pode ter saído dela.{" "}
        <Link to="/channels/@me" className="text-primary underline">
          Voltar às conversas
        </Link>
      </Notice>
    );

  const title = dmTitle(channel, me.id);
  const group = isGroupDm(channel);
  const other = otherRecipient(channel, me.id);
  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-2.5 border-b px-4">
        {group ? (
          <Users className="size-5 text-muted-foreground" aria-hidden />
        ) : (
          <StatusAvatar userId={other?.id} url={other?.avatar_url} name={title} size={28} />
        )}
        <h1 className="truncate font-semibold">{title}</h1>
        <div className="ml-auto flex items-center gap-2">
          {group ? (
            <Button variant="ghost" size="sm" onClick={() => setManaging(true)}>
              <Users /> Participantes ({recipientsOf(channel).length})
            </Button>
          ) : (
            <HeaderStatus userId={other?.id} />
          )}
          <DmCallButton channel={channel} />
        </div>
      </header>
      <DmCallPanel channel={channel} />
      <ChannelView key={channel.id} dm={channel} channelId={channel.id} channelName={title} />
      {group ? (
        <GroupDialog
          key={channel.name}
          channel={channel}
          open={managing}
          onOpenChange={setManaging}
        />
      ) : null}
    </>
  );
}

function HeaderStatus({ userId }: { userId: string | undefined }) {
  const status = usePresence(userId);
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <PresenceDot status={status} className="ring-0" />
      {statusLabel[status]}
    </span>
  );
}
