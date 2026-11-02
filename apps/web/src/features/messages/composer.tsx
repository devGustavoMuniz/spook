import {
  isApiError,
  type MessagePayload,
  startTyping,
  useGetMe,
  useSendMessage,
} from "@spook/shared";
import { useQueryClient } from "@tanstack/react-query";
import { AtSign, Paperclip, Reply, SendHorizontal, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PendingAttachments } from "@/features/attachments/pending-attachments";
import { ACCEPT, MAX_ATTACHMENTS } from "@/features/attachments/rules";
import type { ComposerAttachments } from "@/features/attachments/use-composer-attachments";
import { appMessage } from "@/lib/app-errors";
import { addMessage, truncateRunes } from "@/lib/message-cache";
import { createTypingThrottle } from "../typing/throttle";
import { TypingIndicator } from "../typing/typing-indicator";
import { COUNTER_FROM, MAX_MESSAGE_LENGTH, runeCount } from "./limits";

export function MessageComposer({
  channelId,
  channelName,
  isDm = false,
  canSend,
  attachments,
  nameOf,
  replyTo = null,
  onCancelReply,
  onEditLast,
  focusToken = 0,
}: {
  channelId: string;
  channelName: string;
  /** DM: o campo fala "com <nome>" em vez de "em #canal". */
  isDm?: boolean;
  canSend: boolean;
  /** Fila de anexos do canal (botão, arrastar e soltar e colar entram por aqui). */
  attachments: ComposerAttachments;
  /** Resolve o nome de quem está digitando (membro do servidor ou participante da DM). */
  nameOf: (userId: string) => string | undefined;
  /** Mensagem a que esta está respondendo (barra "Respondendo a…"); `null` = mensagem comum. */
  replyTo?: MessagePayload | null;
  onCancelReply?: () => void;
  /** ↑ com o campo vazio: abre a edição da última mensagem do próprio usuário. */
  onEditLast?: () => void;
  /** Muda para devolver o foco ao campo (depois de editar, responder etc.). */
  focusToken?: number;
}) {
  const qc = useQueryClient();
  const { data: me } = useGetMe();
  const meId = me?.id;
  const send = useSendMessage();
  const [text, setText] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const input = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const { queue, items, addFiles, canAttach } = attachments;
  // "Digitando…" no máximo a cada 3 s por canal (o servidor também limita); recomeça ao trocar de canal.
  // biome-ignore lint/correctness/useExhaustiveDependencies: um throttle novo por canal
  const typing = useMemo(() => createTypingThrottle(), [channelId]);

  // @ na resposta: liga/desliga a menção ao autor da mensagem respondida (padrão ligado a cada resposta).
  const [mentionReply, setMentionReply] = useState(true);
  const replyId = replyTo?.id;
  useEffect(() => {
    setMentionReply(true);
    if (replyId) input.current?.focus();
  }, [replyId]);
  useEffect(() => {
    if (focusToken > 0) input.current?.focus();
  }, [focusToken]);

  // Contagem regressiva do 429 (Retry-After).
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const length = runeCount(text);
  const tooLong = length > MAX_MESSAGE_LENGTH;
  const empty = text.trim().length === 0;
  const blocked = cooldown > 0;
  // Com anexo a mensagem pode ir sem texto, mas só depois de todos os envios terminarem.
  const hasFiles = items.length > 0;
  const uploading = items.some((i) => i.status === "uploading");
  const failed = items.some((i) => i.status === "error");
  const canSubmit =
    canSend &&
    (!empty || hasFiles) &&
    !uploading &&
    !failed &&
    !tooLong &&
    !blocked &&
    !send.isPending;

  async function submit() {
    if (!canSubmit) return;
    // Envio otimista: o campo é limpo AGORA, não quando o POST responde. Assim o que a pessoa digita enquanto o envio
    // está pendente não é apagado junto. O texto enviado fica guardado para voltar ao campo só se o envio falhar.
    const sentText = text;
    const sentFiles = items.map((i) => i.id);
    const sentIds = hasFiles ? queue.uploadIds() : [];
    const sentReply = replyTo ? { reply_to: replyTo.id, mention_reply: mentionReply } : {};
    setText("");
    typing.reset();
    try {
      const msg = await send.mutateAsync({
        channelId,
        data: { content: sentText, ...(hasFiles ? { attachment_ids: sentIds } : {}), ...sentReply },
      });
      addMessage(qc, channelId, msg);
      if (replyTo) onCancelReply?.();
      // Remove só os anexos que foram nesta mensagem; os que a pessoa adicionou durante o envio continuam na fila.
      for (const id of sentFiles) queue.remove(id);
    } catch (e) {
      // Falhou: devolve o texto, sem perder o que foi digitado depois do envio.
      setText((current) => (current ? `${sentText}\n${current}` : sentText));
      if (isApiError(e) && e.status === 429) setCooldown(Math.max(1, Math.ceil(e.retryAfter ?? 1)));
      else if (isApiError(e) && e.status === 422 && replyTo) {
        // A original sumiu ou é de outro canal: o servidor explica; a resposta deixa de valer.
        toast.error(e.detail || appMessage(e));
        onCancelReply?.();
      } else if (isApiError(e) && e.status === 422 && hasFiles) {
        toast.error(e.detail ? `Anexo recusado: ${e.detail}` : appMessage(e));
        queue.invalidateAll("Envie este arquivo de novo.");
      } else toast.error(appMessage(e));
    } finally {
      input.current?.focus();
    }
  }

  if (!canSend) {
    return (
      <div className="px-4 pb-4">
        <p className="rounded-2xl border border-border bg-surface-1 px-4 py-3 text-sm text-muted-foreground">
          Você não tem permissão para enviar mensagens neste canal.
        </p>
      </div>
    );
  }

  const showCounter = length >= COUNTER_FROM || tooLong;
  const status = blocked
    ? `Você está enviando rápido demais. Aguarde ${cooldown} s…`
    : !canAttach
      ? "Você não tem permissão para anexar arquivos neste canal."
      : uploading
        ? "Enviando anexos… a mensagem pode ser enviada quando terminar."
        : failed
          ? "Há anexos com erro: tente de novo ou remova-os para enviar."
          : null;

  return (
    <form
      className="flex flex-col gap-1 px-3 pt-1 pb-3 sm:px-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div
        className={`overflow-hidden rounded-2xl border bg-surface-2 shadow-sm transition-[border-color,box-shadow] duration-[var(--dur-base)] focus-within:border-ring focus-within:shadow-md ${
          tooLong ? "border-destructive-text" : "border-input"
        }`}
      >
        {replyTo ? (
          <ReplyBar
            reply={replyTo}
            name={replyTo.author.display_name || replyTo.author.username}
            mention={mentionReply}
            onMentionChange={setMentionReply}
            canMention={replyTo.author.id !== meId}
            onCancel={() => {
              onCancelReply?.();
              input.current?.focus();
            }}
          />
        ) : null}
        <PendingAttachments
          items={items}
          onRemove={queue.remove.bind(queue)}
          onRetry={queue.retry.bind(queue)}
        />
        <div className="flex items-end gap-1 p-1.5">
          <input
            ref={picker}
            type="file"
            multiple
            accept={ACCEPT}
            className="hidden"
            tabIndex={-1}
            aria-label="Escolher arquivos"
            data-testid="attachment-input"
            onChange={(e) => {
              addFiles([...(e.target.files ?? [])]);
              e.target.value = ""; // permite escolher o mesmo arquivo de novo
            }}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-10 shrink-0 rounded-xl text-muted-foreground"
                aria-label="Anexar arquivo"
                disabled={!canAttach || items.length >= MAX_ATTACHMENTS}
                onClick={() => picker.current?.click()}
              >
                <Paperclip />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {canAttach
                ? `Anexar arquivos (até ${MAX_ATTACHMENTS}, 25 MB cada)`
                : "Você não tem permissão para anexar arquivos neste canal"}
            </TooltipContent>
          </Tooltip>
          <textarea
            ref={input}
            aria-label={isDm ? `Mensagem para ${channelName}` : `Mensagem em #${channelName}`}
            placeholder={isDm ? `Conversar com ${channelName}` : `Conversar em #${channelName}`}
            rows={1}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              // Falha no aviso não atrapalha quem escreve: o indicador dos outros é só um detalhe.
              if (canSend && typing.shouldSend(e.target.value))
                void startTyping(channelId).catch(() => {});
            }}
            onPaste={(e) => {
              // Colar imagem (print) vira anexo; texto colado segue o caminho normal.
              const files = [...e.clipboardData.files];
              if (files.length === 0) return;
              e.preventDefault();
              addFiles(files);
            }}
            onKeyDown={(e) => {
              // Enter envia; Shift+Enter quebra linha. Não envia no meio de uma composição (IME).
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void submit();
              } else if (e.key === "Escape" && replyTo) {
                e.preventDefault();
                onCancelReply?.();
              } else if (
                e.key === "ArrowUp" &&
                onEditLast &&
                text === "" &&
                !e.shiftKey &&
                !e.ctrlKey &&
                !e.metaKey &&
                !e.altKey &&
                !e.nativeEvent.isComposing
              ) {
                // Campo vazio: ↑ abre a edição da última mensagem sua (como no Discord).
                e.preventDefault();
                onEditLast();
              }
            }}
            aria-invalid={tooLong}
            aria-describedby="composer-info"
            className="field-sizing-content max-h-40 min-h-10 min-w-0 flex-1 resize-none bg-transparent px-2 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus-visible:outline-none"
          />
          {showCounter ? (
            <span
              className={`tabular self-center pr-1 text-xs ${tooLong ? "font-semibold text-destructive-text" : "text-muted-foreground"}`}
            >
              {length}/{MAX_MESSAGE_LENGTH}
            </span>
          ) : null}
          <Button
            type="submit"
            size="icon"
            variant={canSubmit ? "default" : "secondary"}
            className="size-10 shrink-0 rounded-xl"
            aria-label="Enviar mensagem"
            disabled={!canSubmit}
          >
            <SendHorizontal />
          </Button>
        </div>
      </div>
      <div className="flex min-h-4 items-center justify-between gap-3">
        <TypingIndicator channelId={channelId} nameOf={nameOf} />
        <p className="hidden shrink-0 items-center gap-1 text-2xs text-muted-foreground md:flex">
          <Kbd>Enter</Kbd> envia <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> nova linha
        </p>
      </div>
      <div id="composer-info" aria-live="polite" className="empty:hidden">
        {status ? (
          <output
            className={`block text-xs ${blocked || failed ? "text-destructive-text" : "text-muted-foreground"}`}
          >
            {status}
          </output>
        ) : null}
      </div>
    </form>
  );
}

/** Barra acima do campo: "Respondendo a <nome>", prévia, interruptor de @ e cancelar. */
function ReplyBar({
  reply,
  name,
  mention,
  onMentionChange,
  canMention,
  onCancel,
}: {
  reply: MessagePayload;
  name: string;
  mention: boolean;
  onMentionChange: (on: boolean) => void;
  /** Responder a si mesmo não menciona ninguém: sem interruptor. */
  canMention: boolean;
  onCancel: () => void;
}) {
  const preview =
    truncateRunes(reply.content, 80) || ((reply.attachments ?? []).length > 0 ? "Anexo" : "");
  return (
    <fieldset
      aria-label={`Respondendo a ${name}`}
      className="flex min-w-0 items-center gap-2 border-b border-border bg-surface-1 px-3 py-2 text-xs"
    >
      <Reply className="size-4 shrink-0 text-brand-text" aria-hidden />
      <span className="min-w-0 flex-1 truncate">
        Respondendo a <strong className="font-semibold">{name}</strong>
        <span className="ml-2 text-muted-foreground">{preview}</span>
      </span>
      {canMention ? (
        <Button
          type="button"
          variant={mention ? "soft" : "ghost"}
          size="sm"
          className="h-7 gap-1 px-2 text-xs"
          aria-pressed={mention}
          aria-label={`Mencionar ${name}`}
          title={
            mention
              ? `${name} será notificado(a). Clique para não mencionar.`
              : `${name} não será notificado(a). Clique para mencionar.`
          }
          onClick={() => onMentionChange(!mention)}
        >
          <AtSign className="size-3" aria-hidden />
          {mention ? "ativado" : "desativado"}
        </Button>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7"
        aria-label="Cancelar resposta"
        title="Cancelar (Esc)"
        onClick={onCancel}
      >
        <X className="size-4" />
      </Button>
    </fieldset>
  );
}
