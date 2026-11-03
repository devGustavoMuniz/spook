// A lista usa o TanStack Virtual, que não combina com a memoização automática do React Compiler
// (o virtualizer é mutável); por isso o componente opta por não usar o compilador e os itens são memoizados à mão.

import type { MessagePayload } from "@spook/shared";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, Hash, Loader2, MessageCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { EmptyChatIllustration } from "@/components/illustrations";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { useT } from "@/i18n";
import { ImageViewerProvider } from "../attachments/viewer-context";
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
  /** user_id → apelido no servidor (nome exibido: apelido > nome de exibição > username). */
  nicknames?: ReadonlyMap<string, string>;
  /** Usernames (minúsculos) de quem está na conversa: viram pílula de menção. */
  mentionable?: ReadonlySet<string>;
  /** Cargos, meus cargos e "suprimir @everyone": menções em massa (pílulas e destaque). */
  mentionCtx?: MessageRowProps["mentionCtx"];
  /** Cartão de perfil do autor (clique no nome/avatar). */
  onOpenProfile?: MessageRowProps["onOpenProfile"];
  /** Estado vazio: "Escrever primeira mensagem" devolve o foco ao composer. */
  onFocusComposer?: () => void;
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
const FAR_FROM_BOTTOM_PX = 480;

/**
 * Lista invertida: cresce para cima e fica ancorada no fim. O virtualizer faz `anchorTo: "end"`
 * (ao entrar páginas anteriores, mantém o item visível no mesmo lugar) e `followOnAppend` (mensagem
 * nova no fim acompanha a rolagem só se o usuário já estava no fim).
 */
export function MessageList(props: MessageListProps) {
  "use no memo";
  const { t, locale } = useT();
  const { messages, hasMore, loadingMore, onLoadMore } = props;
  const parentRef = useRef<HTMLDivElement>(null);
  const { newAfterId, myId } = props;
  // `locale` na dependência: o rótulo do dia ("30 de outubro…") é formatado em buildRows.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refaz as linhas ao trocar de idioma
  const rows = useMemo(
    () => buildRows(messages, { hasMore, newAfterId, myId }),
    [messages, hasMore, newAfterId, myId, locale],
  );

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => {
      const r = rows[i];
      if (!r || r.kind === "start") return 176;
      return (
        (r.header ? 64 + (r.day ? 48 : 0) : 26) +
        (r.marker ? 36 : 0) +
        (r.message.reply_to ? 28 : 0)
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
  // "Pular para o presente": aparece quando o usuário rolou para longe do fim; conta as mensagens que
  // chegaram de outras pessoas enquanto ele estava longe.
  const [away, setAway] = useState(false);
  const [unseen, setUnseen] = useState(0);
  function reportBottom() {
    const el = parentRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setAtBottom(distance <= BOTTOM_THRESHOLD_PX);
    const far = distance > FAR_FROM_BOTTOM_PX;
    setAway(far);
    if (!far) setUnseen(0);
  }
  const awayRef = useRef(false);
  awayRef.current = away;
  const prevCount = useRef(messages.length);
  const lastMine = lastAuthor === props.myId;
  // biome-ignore lint/correctness/useExhaustiveDependencies: conta só quando a última mensagem muda
  useEffect(() => {
    if (
      prevCount.current > 0 &&
      messages.length > prevCount.current &&
      awayRef.current &&
      !lastMine
    )
      setUnseen((n) => n + (messages.length - prevCount.current));
    prevCount.current = messages.length;
  }, [lastId]);
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

  if (messages.length === 0 && !hasMore) {
    return (
      <div
        role="log"
        aria-label={t("chat.list.messagesOf", { name: props.channelName })}
        className="relative min-h-0 flex-1 overflow-y-auto bg-brand-wash"
      >
        <EmptyState
          illustration={<EmptyChatIllustration className="h-40 w-auto" />}
          title={props.isDm ? t("chat.list.emptyDmTitle") : t("chat.list.emptyChannelTitle")}
          description={
            props.isDm
              ? t("chat.list.emptyDmDescription", { name: props.channelName })
              : t("chat.list.emptyChannelDescription", { name: props.channelName })
          }
          action={
            props.onFocusComposer ? (
              <Button onClick={props.onFocusComposer}>
                <MessageCircle /> {t("chat.list.writeFirst")}
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  }

  return (
    <ImageViewerProvider messages={messages}>
      <div className="relative min-h-0 flex-1">
        {loadingMore ? (
          <output className="absolute top-2 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full border bg-popover px-3 py-1 text-xs text-muted-foreground shadow-md">
            <Loader2 className="size-3 animate-spin motion-essential" />{" "}
            {t("chat.list.loadingOlder")}
          </output>
        ) : null}
        <div
          ref={parentRef}
          onScroll={maybeLoadMore}
          role="log"
          aria-label={t("chat.list.messagesOf", { name: props.channelName })}
          aria-live="polite"
          aria-relevant="additions"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: região rolável precisa de foco para rolar pelo teclado
          tabIndex={0}
          className="h-full overflow-y-auto pt-4 pb-2 [overflow-anchor:none]"
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
                    <ChannelStart name={props.channelName} isDm={props.isDm} />
                  ) : (
                    <MessageRow
                      message={row.message}
                      header={row.header}
                      day={row.day}
                      marker={row.marker}
                      myId={props.myId}
                      myUsername={props.myUsername}
                      mentionable={props.mentionable}
                      mentionCtx={props.mentionCtx}
                      color={props.colors.get(row.message.author.id)}
                      nickname={props.nicknames?.get(row.message.author.id)}
                      canEdit={row.message.author.id === props.myId}
                      canDelete={row.message.author.id === props.myId || props.canManageMessages}
                      canReply={props.canReply}
                      canPin={props.canPin}
                      highlighted={highlightId === row.message.id}
                      replyTarget={props.replyingToId === row.message.id}
                      onReply={props.onReply}
                      onTogglePin={props.onTogglePin}
                      onJumpTo={props.onJumpTo}
                      onOpenProfile={props.onOpenProfile}
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
        {away ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full border border-border shadow-lg"
            onClick={() => {
              virtualizer.scrollToEnd();
              setUnseen(0);
            }}
          >
            <ArrowDown />
            {unseen > 0
              ? t("chat.list.newMessages", { count: unseen })
              : t("chat.list.jumpToPresent")}
          </Button>
        ) : null}
      </div>
    </ImageViewerProvider>
  );
}

/** Começo do histórico: ícone grande do canal (ou da conversa), título e uma frase. */
function ChannelStart({ name, isDm }: { name: string; isDm?: boolean }) {
  const { t } = useT();
  return (
    <div className="flex flex-col gap-2 px-4 pt-8 pb-6">
      <span className="flex size-14 items-center justify-center rounded-2xl bg-accent text-brand-text">
        {isDm ? (
          <MessageCircle className="size-7" aria-hidden />
        ) : (
          <Hash className="size-7" aria-hidden />
        )}
      </span>
      <p className="text-2xl font-semibold tracking-tight">
        {isDm ? t("chat.list.startDm", { name }) : t("chat.list.startChannel", { name })}
      </p>
      <p className="text-sm text-muted-foreground">
        {isDm ? t("chat.list.startDmHint") : t("chat.list.startChannelHint")}
      </p>
    </div>
  );
}
