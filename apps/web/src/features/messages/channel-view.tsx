import {
  type ChannelPayload,
  listMessages,
  type MessagePayload,
  Permission,
  useDeleteMessage,
  useEditMessage,
  useGetMe,
} from "@spook/shared";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Paperclip } from "lucide-react";
import type { DragEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { useComposerAttachments } from "@/features/attachments/use-composer-attachments";
import { recipientName, recipientsOf } from "@/features/dms/dm-utils";
import { memberName, useGuildMembers, useMemberColors } from "@/features/members/use-members";
import { useAutoAck } from "@/features/notifications/use-auto-ack";
import { useEntryMarker } from "@/features/notifications/use-entry-marker";
import { useViewportStore } from "@/features/notifications/viewport";
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
import { MAX_JUMP_PAGES, useJumpStore } from "./jump";
import { MessageList } from "./message-list";
import { usePinToggle } from "./use-pin";

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
  dm,
  channelId,
  channelName,
  perf,
}: {
  /** Canal de servidor: dá as permissões, as cores dos cargos e os nomes de quem digita. */
  guild?: Guild;
  /** DM: sem permissões de servidor (só o autor edita ou exclui); quem digita vem dos participantes. */
  dm?: ChannelPayload;
  channelId: string;
  channelName: string;
  /** Só em dev (`?perf=N`): troca o histórico por N mensagens falsas locais. */
  perf?: number;
}) {
  const qc = useQueryClient();
  const { data: me } = useGetMe();
  const colors = useMemberColors(guild);
  const guildMembers = useGuildMembers(guild?.id ?? "", !!guild);
  const nameOf = (userId: string) => {
    if (dm) {
      const r = recipientsOf(dm).find((x) => x.id === userId);
      return r ? recipientName(r) : undefined;
    }
    const m = guildMembers.data?.members?.find((x) => x.user_id === userId);
    return m ? memberName(m) : undefined;
  };
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

  const canViewChannel = guild ? can(guild, Permission.VIEW_CHANNEL) : true;
  const canAttach = guild ? can(guild, Permission.ATTACH_FILES) : true;
  const attachments = useComposerAttachments(channelId, canAttach);
  const drag = useFileDrop(attachments.addFiles);

  // Onde o usuário está olhando (define o que conta como não lido) e a leitura automática.
  const setViewChannel = useViewportStore((s) => s.setChannel);
  useEffect(() => {
    if (perfOn) return;
    setViewChannel(channelId);
    return () => setViewChannel(null);
  }, [channelId, perfOn, setViewChannel]);
  useAutoAck(channelId, messages.at(-1)?.id, !perfOn && !query.isPending && canViewChannel);
  const newAfterId = useEntryMarker(channelId);

  const edit = useEditMessage();
  const del = useDeleteMessage();
  const pins = usePinToggle(channelId);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<MessagePayload | null>(null);
  // Responder: a mensagem alvo vale só no canal em que foi escolhida (o ChannelView do servidor não remonta).
  const [replying, setReplying] = useState<{ channelId: string; message: MessagePayload } | null>(
    null,
  );
  const replyTo = replying?.channelId === channelId ? replying.message : null;
  const [focusToken, setFocusToken] = useState(0);
  const [jump, setJump] = useState<{ messageId: string; nonce: number } | null>(null);

  // Mensagens mais recentes sem entrar nas dependências dos efeitos/handlers abaixo.
  const latest = useRef({ messages, query });
  useEffect(() => {
    latest.current = { messages, query };
  });

  /**
   * Leva até uma mensagem: se não está carregada, busca páginas anteriores (até MAX_JUMP_PAGES) à procura
   * dela; se não achar, avisa que está fora do histórico carregado.
   */
  const goTo = useCallback(async (messageId: string) => {
    const has = (list: MessagePayload[]) => list.some((m) => m.id === messageId);
    const found = () => setJump((j) => ({ messageId, nonce: (j?.nonce ?? 0) + 1 }));
    if (has(latest.current.messages)) return found();
    let more = latest.current.query.hasNextPage;
    for (let page = 0; page < MAX_JUMP_PAGES && more; page++) {
      const r = await latest.current.query.fetchNextPage({ cancelRefetch: false });
      if (has(flattenPages(r.data))) return found();
      more = r.hasNextPage;
    }
    toast.info("Essa mensagem está fora do histórico carregado.");
  }, []);

  // Pedidos de outras partes da tela (painel de fixadas) para ir até uma mensagem deste canal.
  const jumpRequest = useJumpStore((s) => s.request);
  useEffect(() => {
    if (!jumpRequest || jumpRequest.channelId !== channelId) return;
    useJumpStore.setState({ request: null });
    void goTo(jumpRequest.messageId);
  }, [jumpRequest, channelId, goTo]);

  // ↑ com o campo vazio: edita a última mensagem do próprio usuário (a mais nova do cache).
  function editLast() {
    const mine = [...messages].reverse().find((m) => m.author.id === me?.id);
    if (!mine) return;
    setEditingId(mine.id);
    setJump((j) => ({ messageId: mine.id, nonce: (j?.nonce ?? 0) + 1 }));
  }

  function stopEditing() {
    setEditingId(null);
    setFocusToken((n) => n + 1);
  }

  async function saveEdit(id: string, content: string) {
    try {
      const msg = await edit.mutateAsync({ channelId, messageId: id, data: { content } });
      replaceMessage(qc, channelId, msg);
      stopEditing();
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
  // Em DM quem participa vê e escreve; o servidor responde 404 para quem não participa.
  const canView = guild ? can(guild, Permission.VIEW_CHANNEL) : true;
  const canSend = guild ? canView && can(guild, Permission.SEND_MESSAGES) : true;
  // Fixar: MANAGE_MESSAGES no servidor; qualquer participante em DM.
  const canPin = guild ? canView && can(guild, Permission.MANAGE_MESSAGES) : true;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: soltar arquivos é um atalho; o botão "Anexar arquivo" faz o mesmo pelo teclado
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      onDragEnter={drag.onDragEnter}
      onDragOver={drag.onDragOver}
      onDragLeave={drag.onDragLeave}
      onDrop={drag.onDrop}
    >
      {drag.active && canSend ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center gap-2 bg-background/80 text-lg font-semibold ring-2 ring-primary ring-inset"
        >
          <Paperclip /> Solte para anexar
        </div>
      ) : null}
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
          isDm={!!dm}
          messages={messages}
          hasMore={perfOn ? false : !!query.hasNextPage}
          loadingMore={query.isFetchingNextPage}
          onLoadMore={() => void query.fetchNextPage({ cancelRefetch: false })}
          colors={colors}
          myId={me.id}
          myUsername={me.username}
          newAfterId={newAfterId}
          canManageMessages={guild ? can(guild, Permission.MANAGE_MESSAGES) : false}
          canReply={canSend && !perfOn}
          canPin={canPin && !perfOn}
          replyingToId={replyTo?.id}
          jump={jump}
          onReply={(m) => setReplying({ channelId, message: m })}
          onTogglePin={(m) => void pins.toggle(m)}
          onJumpTo={(id) => void goTo(id)}
          editingId={editingId}
          onStartEdit={setEditingId}
          onCancelEdit={stopEditing}
          onSaveEdit={saveEdit}
          onDelete={setToDelete}
        />
      )}
      <MessageComposer
        channelId={channelId}
        channelName={channelName}
        isDm={!!dm}
        nameOf={nameOf}
        canSend={canSend && !perfOn}
        attachments={attachments}
        replyTo={replyTo}
        onCancelReply={() => setReplying(null)}
        onEditLast={editLast}
        focusToken={focusToken}
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

/** Arrastar e soltar arquivos sobre a área do canal (ignora arrastos que não são de arquivos). */
function useFileDrop(onFiles: (files: File[]) => void) {
  const [active, setActive] = useState(false);
  // dragenter/dragleave disparam também nos filhos: o contador evita o overlay piscar.
  const depth = useRef(0);
  const hasFiles = (e: DragEvent) => e.dataTransfer?.types?.includes("Files") ?? false;
  return {
    active,
    onDragEnter(e: DragEvent) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current++;
      setActive(true);
    },
    onDragOver(e: DragEvent) {
      if (hasFiles(e)) e.preventDefault(); // sem isso o navegador não aceita o drop
    },
    onDragLeave(e: DragEvent) {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setActive(false);
    },
    onDrop(e: DragEvent) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setActive(false);
      onFiles([...e.dataTransfer.files]);
    },
  };
}
