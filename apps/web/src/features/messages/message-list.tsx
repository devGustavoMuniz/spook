// A lista usa o TanStack Virtual, que não combina com a memoização automática do React Compiler
// (o virtualizer é mutável); por isso o componente opta por não usar o compilador e os itens são memoizados à mão.

import type { MessagePayload } from "@spook/shared";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
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
  canManageMessages: boolean;
  editingId: string | null;
  onStartEdit: MessageRowProps["onStartEdit"];
  onCancelEdit: MessageRowProps["onCancelEdit"];
  onSaveEdit: MessageRowProps["onSaveEdit"];
  onDelete: MessageRowProps["onDelete"];
};

const LOAD_MORE_THRESHOLD_PX = 400;

/**
 * Lista invertida: cresce para cima e fica ancorada no fim. O virtualizer faz `anchorTo: "end"`
 * (ao entrar páginas anteriores, mantém o item visível no mesmo lugar) e `followOnAppend` (mensagem
 * nova no fim acompanha a rolagem só se o usuário já estava no fim).
 */
export function MessageList(props: MessageListProps) {
  "use no memo";
  const { messages, hasMore, loadingMore, onLoadMore } = props;
  const parentRef = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => buildRows(messages, { hasMore }), [messages, hasMore]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => {
      const r = rows[i];
      if (!r || r.kind === "start") return 72;
      return r.header ? 64 + (r.day ? 40 : 0) : 26;
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

  // Só rolagem para cima pede página anterior (ignora os saltos programáticos de ancoragem).
  const lastTop = useRef<number | null>(null);
  function maybeLoadMore() {
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
                    color={props.colors.get(row.message.author.id)}
                    canEdit={row.message.author.id === props.myId}
                    canDelete={row.message.author.id === props.myId || props.canManageMessages}
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
