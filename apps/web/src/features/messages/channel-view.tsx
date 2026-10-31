import {
  listMessages,
  type MessagePayload,
  Permission,
  useDeleteMessage,
  useEditMessage,
  useGetMe,
} from "@spook/shared";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useMemberColors } from "@/features/members/use-members";
import { appMessage } from "@/lib/app-errors";
import { can, type Guild } from "@/lib/guild";
import {
  flattenPages,
  type MessagePages,
  removeMessage,
  replaceMessage,
} from "@/lib/message-cache";
import { makePerfMessages } from "@/lib/perf";
import { queryKeys } from "@/lib/queryKeys";
import { MessageComposer } from "./composer";
import { MessageList } from "./message-list";

const PAGE_SIZE = 50;

/** Histórico do canal: useInfiniteQuery paginando por `before` (cursor = id da mais antiga). */
function useChannelMessages(channelId: string, enabled: boolean) {
  const q = useInfiniteQuery<
    Awaited<ReturnType<typeof listMessages>>,
    Error,
    MessagePages,
    ReturnType<typeof queryKeys.messages>,
    string | undefined
  >({
    queryKey: queryKeys.messages(channelId),
    enabled,
    initialPageParam: undefined,
    queryFn: ({ pageParam, signal }) =>
      listMessages(channelId, { limit: PAGE_SIZE, before: pageParam }, { signal }),
    getNextPageParam: (last) => {
      const msgs = last.messages ?? [];
      return last.has_more && msgs.length > 0 ? msgs[msgs.length - 1]?.id : undefined;
    },
  });
  return q;
}

export function ChannelView({
  guild,
  channelId,
  channelName,
  perf,
}: {
  guild: Guild;
  channelId: string;
  channelName: string;
  /** Só em dev (`?perf=N`): troca o histórico por N mensagens falsas locais. */
  perf?: number;
}) {
  const qc = useQueryClient();
  const { data: me } = useGetMe();
  const colors = useMemberColors(guild);
  const perfOn = import.meta.env.DEV && !!perf;
  const query = useChannelMessages(channelId, !perfOn);
  const perfMessages = useMemo(
    () => (perfOn ? makePerfMessages(perf ?? 0, channelId) : []),
    [perfOn, perf, channelId],
  );
  const messages = useMemo(
    () => (perfOn ? perfMessages : flattenPages(query.data)),
    [perfOn, perfMessages, query.data],
  );

  const edit = useEditMessage();
  const del = useDeleteMessage();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<MessagePayload | null>(null);

  async function saveEdit(id: string, content: string) {
    try {
      const msg = await edit.mutateAsync({ channelId, messageId: id, data: { content } });
      replaceMessage(qc, channelId, msg);
      setEditingId(null);
    } catch (e) {
      toast.error(appMessage(e));
    }
  }

  async function confirmDelete() {
    const m = toDelete;
    if (!m) return;
    try {
      await del.mutateAsync({ channelId, messageId: m.id });
      removeMessage(qc, channelId, m.id);
    } catch (e) {
      toast.error(appMessage(e));
    } finally {
      setToDelete(null);
    }
  }

  if (!me) return null;
  const canView = can(guild, Permission.VIEW_CHANNEL);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {!canView ? (
        <p className="p-6 text-sm text-muted-foreground">Você não pode ver este canal.</p>
      ) : query.isPending && !perfOn ? (
        <output className="block p-6 text-sm text-muted-foreground">Carregando mensagens…</output>
      ) : query.isError && !perfOn ? (
        <div className="p-6 text-sm">
          <p className="text-destructive-text">{appMessage(query.error)}</p>
          <button type="button" className="mt-2 underline" onClick={() => void query.refetch()}>
            Tentar de novo
          </button>
        </div>
      ) : (
        <MessageList
          key={channelId}
          channelName={channelName}
          messages={messages}
          hasMore={perfOn ? false : !!query.hasNextPage}
          loadingMore={query.isFetchingNextPage}
          onLoadMore={() => void query.fetchNextPage({ cancelRefetch: false })}
          colors={colors}
          myId={me.id}
          canManageMessages={can(guild, Permission.MANAGE_MESSAGES)}
          editingId={editingId}
          onStartEdit={setEditingId}
          onCancelEdit={() => setEditingId(null)}
          onSaveEdit={saveEdit}
          onDelete={setToDelete}
        />
      )}
      <MessageComposer
        channelId={channelId}
        channelName={channelName}
        canSend={canView && can(guild, Permission.SEND_MESSAGES) && !perfOn}
      />
      <AlertDialog open={!!toDelete} onOpenChange={(o) => !o && setToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogTitle>Excluir mensagem?</AlertDialogTitle>
          <AlertDialogDescription>
            Esta ação não pode ser desfeita.
            {toDelete ? (
              <span className="mt-2 block max-h-24 overflow-hidden rounded-md border p-2 text-foreground">
                {toDelete.content}
              </span>
            ) : null}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDelete()}>Excluir</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
