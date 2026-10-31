import { isApiError, startTyping, useSendMessage } from "@spook/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Paperclip, SendHorizontal } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { PendingAttachments } from "@/features/attachments/pending-attachments";
import { ACCEPT, MAX_ATTACHMENTS } from "@/features/attachments/rules";
import type { ComposerAttachments } from "@/features/attachments/use-composer-attachments";
import { appMessage } from "@/lib/app-errors";
import { addMessage } from "@/lib/message-cache";
import { createTypingThrottle } from "../typing/throttle";
import { TypingIndicator } from "../typing/typing-indicator";
import { MAX_MESSAGE_LENGTH, runeCount } from "./limits";

export function MessageComposer({
  channelId,
  channelName,
  isDm = false,
  canSend,
  attachments,
  nameOf,
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
}) {
  const qc = useQueryClient();
  const send = useSendMessage();
  const [text, setText] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const input = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const { queue, items, addFiles, canAttach } = attachments;
  // "Digitando…" no máximo a cada 3 s por canal (o servidor também limita); recomeça ao trocar de canal.
  // biome-ignore lint/correctness/useExhaustiveDependencies: um throttle novo por canal
  const typing = useMemo(() => createTypingThrottle(), [channelId]);

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
    try {
      const msg = await send.mutateAsync({
        channelId,
        data: { content: text, ...(hasFiles ? { attachment_ids: queue.uploadIds() } : {}) },
      });
      addMessage(qc, channelId, msg);
      typing.reset();
      setText("");
      queue.clear();
    } catch (e) {
      if (isApiError(e) && e.status === 429) setCooldown(Math.max(1, Math.ceil(e.retryAfter ?? 1)));
      else if (isApiError(e) && e.status === 422 && hasFiles) {
        toast.error(e.detail ? `Anexo recusado: ${e.detail}` : appMessage(e));
        queue.invalidateAll("Envie este arquivo de novo.");
      } else toast.error(appMessage(e));
    } finally {
      input.current?.focus();
    }
  }

  if (!canSend) {
    return (
      <div className="border-t px-4 py-3 text-sm text-muted-foreground">
        Você não tem permissão para enviar mensagens neste canal.
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-1 border-t px-4 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <PendingAttachments
        items={items}
        onRemove={queue.remove.bind(queue)}
        onRetry={queue.retry.bind(queue)}
      />
      <div className="flex items-end gap-2">
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
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Anexar arquivo"
          title={
            canAttach
              ? `Anexar arquivos (até ${MAX_ATTACHMENTS}, 25 MB cada)`
              : "Você não tem permissão para anexar arquivos neste canal"
          }
          disabled={!canAttach || items.length >= MAX_ATTACHMENTS}
          onClick={() => picker.current?.click()}
        >
          <Paperclip />
        </Button>
        <Textarea
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
            }
          }}
          aria-invalid={tooLong}
          aria-describedby="composer-info"
          className="field-sizing-content max-h-40 min-h-10 resize-none"
        />
        <Button type="submit" size="icon" aria-label="Enviar mensagem" disabled={!canSubmit}>
          <SendHorizontal />
        </Button>
      </div>
      <TypingIndicator channelId={channelId} nameOf={nameOf} />
      <div
        id="composer-info"
        className="flex justify-between gap-2 text-xs text-muted-foreground"
        aria-live="polite"
      >
        <output className={blocked ? "text-destructive-text" : undefined}>
          {blocked
            ? `Você está enviando rápido demais. Aguarde ${cooldown} s…`
            : !canAttach
              ? "Você não tem permissão para anexar arquivos neste canal."
              : uploading
                ? "Enviando anexos… a mensagem pode ser enviada quando terminar."
                : failed
                  ? "Há anexos com erro: tente de novo ou remova-os para enviar."
                  : null}
        </output>
        <span className={tooLong ? "text-destructive-text" : undefined}>
          {length}/{MAX_MESSAGE_LENGTH}
        </span>
      </div>
    </form>
  );
}
