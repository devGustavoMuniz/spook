// A lista usa o TanStack Virtual, que não combina com a memoização automática do React Compiler
// (o virtualizer é mutável); por isso o componente opta por não usar o compilador e os itens são memoizados à mão.

import type { MessagePayload } from "@spook/shared";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useViewportStore } from "../notifications/viewport";
import { MessageRow, type MessageRowProps } from "./message-row";
import { buildRows } from "./rows";

export type MessageListProps = {
  channelName: string;
  /** DM: "início da conversa com X" em vez de "#canal". */
  isDm?: boolean;
  messages: MessagePayload[];
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  colors: ReadonlyMap<string, string>;
  myId: string;
  myUsername: string;
  /** Ponto de leitura de quando o canal foi aberto: a mensagem seguinte ganha "Novas mensagens". */
  newAfterId?: string | null;
  canManageMessages: boolean;
  /** Pode responder e fixar (já calculado pelo canal: servidor ou DM). */
  canReply: boolean;
  canPin: boolean;
  /** Mensagem a que o composer responde agora (ganha realce). */
  replyingToId?: string | null;
  /** Pedido de rolar até uma mensagem já carregada (citação, fixadas, ↑); `nonce` diferencia pedidos iguais. */
  jump?: { messageId: string; nonce: number } | null;
  onReply: MessageRowProps["onReply"];
  onTogglePin: MessageRowProps["onTogglePin"];
  onJumpTo: MessageRowProps["onJumpTo"];
  editingId: string | null;
  onStartEdit: MessageRowProps["onStartEdit"];
  onCancelEdit: MessageRowProps["onCancelEdit"];
  onSaveEdit: MessageRowProps["onSaveEdit"];
  onDelete: MessageRowProps["onDelete"];
};

const LOAD_MORE_THRESHOLD_PX = 400;
const BOTTOM_THRESHOLD_PX = 120;

/**
 * Lista invertida: cresce para cima e fica ancorada no fim. O virtualizer faz `anchorTo: "end"`
 * (ao entrar páginas anteriores, mantém o item visível no mesmo lugar) e `followOnAppend` (mensagem
 * nova no fim acompanha a rolagem só se o usuário já estava no fim).
 */
export function MessageList(props: MessageListProps) {
  "use no memo";
  const { messages, hasMore, loadingMore, onLoadMore } = props;
  const parentRef = useRef<HTMLDivElement>(null);
  const { newAfterId, myId } = props;
  const rows = useMemo(
    () => buildRows(messages, { hasMore, newAfterId, myId }),
    [messages, hasMore, newAfterId, myId],
  );

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => {
      const r = rows[i];
      if (!r || r.kind === "start") return 72;
      return (
        (r.header ? 64 + (r.day ? 40 : 0) : 26) +
        (r.marker ? 28 : 0) +
        (r.message.reply_to ? 24 : 0)
      );
    },
    getItemKey: (i) => rows[i]?.key ?? i,
    overscan: 10,
    anchorTo: "end",
    followOnAppend: true,
    scrollEndThreshold: 120,
  });

  // Entrada no canal: começa no fim. Sem guarda de "já fez": o StrictMode (dev) desmonta e remonta
  // o virtualizer, o que cancela a rolagem iniciada no primeiro efeito.
  const hasMessages = messages.length > 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: roda quando as primeiras mensagens chegam
  useEffect(() => {
    if (hasMessages) virtualizer.scrollToEnd();
  }, [hasMessages]);

  // "Ir até a mensagem": rola até a linha (centralizada) e a destaca por um instante.
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const handledJump = useRef(0);
  const highlightTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const { jump } = props;
  // biome-ignore lint/correctness/useExhaustiveDependencies: roda quando chega um pedido novo ou as linhas mudam (a mensagem pode entrar depois)
  useEffect(() => {
    if (!jump || handledJump.current === jump.nonce) return;
    const index = rows.findIndex((r) => r.kind === "message" && r.message.id === jump.messageId);
    if (index < 0) return;
    handledJump.current = jump.nonce;
    virtualizer.scrollToIndex(index, { align: "center" });
    setHighlightId(jump.messageId);
    clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setHighlightId(null), 2000);
  }, [jump, rows]);
  useEffect(() => () => clearTimeout(highlightTimer.current), []);

  // Minha própria mensagem sempre leva ao fim, mesmo se eu tinha rolado para cima.
  const lastId = messages.at(-1)?.id;
  const lastAuthor = messages.at(-1)?.author.id;
  const prevLastId = useRef(lastId);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reage só à troca da última mensagem
  useEffect(() => {
    if (
      prevLastId.current !== undefined &&
      lastId !== prevLastId.current &&
      lastAuthor === props.myId
    )
      virtualizer.scrollToEnd();
    prevLastId.current = lastId;
  }, [lastId]);

  // A lista está no fim? (as mensagens novas só contam como lidas assim)
  const setAtBottom = useViewportStore((s) => s.setAtBottom);
  function reportBottom() {
    const el = parentRef.current;
    if (el) setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD_PX);
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: reavalia quando o conteúdo muda de tamanho
  useEffect(reportBottom, [rows.length, virtualizer.getTotalSize()]);

  // Só rolagem para cima pede página anterior (ignora os saltos programáticos de ancoragem).
  const lastTop = useRef<number | null>(null);
  function maybeLoadMore() {
    reportBottom();
    const el = parentRef.current;
    if (!el) return;
    const goingUp = lastTop.current !== null && el.scrollTop < lastTop.current;
    lastTop.current = el.scrollTop;
    if (!goingUp || !hasMore || loadingMore) return;
    if (el.scrollTop < LOAD_MORE_THRESHOLD_PX) onLoadMore();
  }

  // Primeira página não preencheu a janela: busca a próxima sem esperar o usuário rolar.
  // biome-ignore lint/correctness/useExhaustiveDependencies: depende do tamanho total e do estado de carga
  useEffect(() => {
    const el = parentRef.current;
    if (
      el &&
      hasMore &&
      !loadingMore &&
      messages.length > 0 &&
      virtualizer.getTotalSize() <= el.clientHeight
    )
      onLoadMore();
  }, [rows.length, hasMore, loadingMore]);

  const items = virtualizer.getVirtualItems();
  return (
    <div className="relative min-h-0 flex-1">
      {loadingMore ? (
        <output className="absolute top-2 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full border bg-popover px-3 py-1 text-xs text-muted-foreground shadow">
          <Loader2 className="size-3 animate-spin" /> Carregando mensagens anteriores…
        </output>
      ) : null}
      <div
        ref={parentRef}
        onScroll={maybeLoadMore}
        role="log"
        aria-label={`Mensagens de ${props.channelName}`}
        aria-live="polite"
        aria-relevant="additions"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: região rolável precisa de foco para rolar pelo teclado
        tabIndex={0}
        className="h-full overflow-y-auto [overflow-anchor:none]"
      >
        <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
          {items.map((item) => {
            const row = rows[item.index];
            if (!row) return null;
            return (
              <div
                key={item.key}
                data-index={item.index}
                ref={virtualizer.measureElement}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${item.start}px)`,
                }}
              >
                {row.kind === "start" ? (
                  <div className="px-4 py-6 text-sm text-muted-foreground">
                    <p className="text-base font-semibold text-foreground">
                      {props.isDm
                        ? `Este é o início da conversa com ${props.channelName}`
                        : `Este é o início de #${props.channelName}`}
                    </p>
                    <p>
                      {props.isDm
                        ? "Aqui começa a história da conversa."
                        : "Aqui começa a história do canal."}
                    </p>
                  </div>
                ) : (
                  <MessageRow
                    message={row.message}
                    header={row.header}
                    day={row.day}
                    marker={row.marker}
                    myId={props.myId}
                    myUsername={props.myUsername}
                    color={props.colors.get(row.message.author.id)}
                    canEdit={row.message.author.id === props.myId}
                    canDelete={row.message.author.id === props.myId || props.canManageMessages}
                    canReply={props.canReply}
                    canPin={props.canPin}
                    highlighted={highlightId === row.message.id}
                    replyTarget={props.replyingToId === row.message.id}
                    onReply={props.onReply}
                    onTogglePin={props.onTogglePin}
                    onJumpTo={props.onJumpTo}
                    editing={props.editingId === row.message.id}
                    onStartEdit={props.onStartEdit}
                    onCancelEdit={props.onCancelEdit}
                    onSaveEdit={props.onSaveEdit}
                    onDelete={props.onDelete}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
