import { useGetMe } from "@spook/shared";
import { Link, Outlet, useParams } from "@tanstack/react-router";
import { ArrowLeft, MessageSquarePlus, Users } from "lucide-react";
import { useState } from "react";
import { EmptyChatIllustration } from "@/components/illustrations";
import { PresenceDot, StatusAvatar, statusLabel } from "@/components/presence-dot";
import { NavToggle } from "@/components/shell";
import { ErrorState, StateScreen } from "@/components/state-screen";
import { Button } from "@/components/ui/button";
import { DmSidebar } from "@/features/dms/dm-sidebar";
import { dmTitle, isGroupDm, otherRecipient, recipientsOf } from "@/features/dms/dm-utils";
import { GroupDialog } from "@/features/dms/group-dialog";
import { NewGroupDialog } from "@/features/dms/new-group-dialog";
import { useDms } from "@/features/dms/use-dms";
import { ChannelView } from "@/features/messages/channel-view";
import { PinnedMessagesButton } from "@/features/messages/pins-panel";
import { CustomStatusText } from "@/features/presence/custom-status-text";
import { usePresence } from "@/features/presence/store";
import { DmCallButton, DmCallPanel } from "@/features/voice/call-panel";

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
  const empty = dms.list.length === 0;
  return (
    <>
      <StateScreen
        illustration={<EmptyChatIllustration className="h-44 w-auto" />}
        title={empty ? "Você ainda não tem conversas" : "Escolha uma conversa"}
        description={
          empty
            ? 'Abra o menu de um membro de um servidor e escolha "Enviar mensagem", ou crie uma conversa em grupo.'
            : "Selecione uma conversa na lista ao lado ou comece uma nova em grupo."
        }
        actions={
          <Button onClick={() => setCreating(true)}>
            {empty ? <MessageSquarePlus /> : <Users />} Criar conversa em grupo
          </Button>
        }
      />
      <NewGroupDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}

/** `/channels/@me/$channelId`: cabeçalho da DM e o painel de mensagens. */
export function DmPage() {
  const { channelId } = useParams({ strict: false }) as { channelId: string };
  const { data: me } = useGetMe();
  const dms = useDms();
  const [managing, setManaging] = useState(false);
  const channel = dms.list.find((c) => c.id === channelId);

  if (dms.isPending || !me) return null;
  if (dms.isError)
    return (
      <ErrorState error={dms.error} onRetry={() => void dms.refetch()} retrying={dms.isFetching} />
    );
  if (!channel)
    return (
      <StateScreen
        title="Conversa não encontrada"
        description="Você pode ter saído dela, ou ela foi removida."
        actions={
          <Button asChild>
            <Link to="/channels/@me">
              <ArrowLeft /> Voltar às conversas
            </Link>
          </Button>
        }
      />
    );

  const title = dmTitle(channel, me.id);
  const group = isGroupDm(channel);
  const other = otherRecipient(channel, me.id);
  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-2.5 border-b px-4">
        <NavToggle />
        {group ? (
          <span
            aria-hidden
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary text-secondary-foreground"
          >
            <Users className="size-4" />
          </span>
        ) : (
          <StatusAvatar userId={other?.id} url={other?.avatar_url} name={title} size={32} />
        )}
        <div className="flex min-w-0 flex-col leading-tight">
          <h1 className="truncate font-semibold">{title}</h1>
          {group ? (
            <p className="truncate text-xs text-muted-foreground">
              {recipientsOf(channel).length} participantes
            </p>
          ) : (
            <HeaderStatus userId={other?.id} />
          )}
        </div>
        <div className="ml-auto flex items-center gap-1">
          {group ? (
            <Button variant="ghost" size="sm" onClick={() => setManaging(true)}>
              <Users /> Participantes ({recipientsOf(channel).length})
            </Button>
          ) : null}
          <PinnedMessagesButton channelId={channel.id} canUnpin />
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
    <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <PresenceDot status={status} className="ring-0" />
      {statusLabel[status]}
      <CustomStatusText userId={userId} className="min-w-0 truncate" prefix="· " />
    </span>
  );
}
