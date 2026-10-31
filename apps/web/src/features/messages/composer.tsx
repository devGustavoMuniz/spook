import { isApiError, useSendMessage } from "@spook/shared";
import { useQueryClient } from "@tanstack/react-query";
import { SendHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { appMessage } from "@/lib/app-errors";
import { addMessage } from "@/lib/message-cache";
import { MAX_MESSAGE_LENGTH, runeCount } from "./limits";

export function MessageComposer({
  channelId,
  channelName,
  canSend,
}: {
  channelId: string;
  channelName: string;
  canSend: boolean;
}) {
  const qc = useQueryClient();
  const send = useSendMessage();
  const [text, setText] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const input = useRef<HTMLTextAreaElement>(null);

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
  const canSubmit = canSend && !empty && !tooLong && !blocked && !send.isPending;

  async function submit() {
    if (!canSubmit) return;
    try {
      const msg = await send.mutateAsync({ channelId, data: { content: text } });
      addMessage(qc, channelId, msg);
      setText("");
    } catch (e) {
      if (isApiError(e) && e.status === 429) setCooldown(Math.max(1, Math.ceil(e.retryAfter ?? 1)));
      else toast.error(appMessage(e));
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
      <div className="flex items-end gap-2">
        <Textarea
          ref={input}
          aria-label={`Mensagem em #${channelName}`}
          placeholder={`Conversar em #${channelName}`}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
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
      <div
        id="composer-info"
        className="flex justify-between gap-2 text-xs text-muted-foreground"
        aria-live="polite"
      >
        <output className={blocked ? "text-destructive-text" : undefined}>
          {blocked ? `Você está enviando rápido demais. Aguarde ${cooldown} s…` : null}
        </output>
        <span className={tooLong ? "text-destructive-text" : undefined}>
          {length}/{MAX_MESSAGE_LENGTH}
        </span>
      </div>
    </form>
  );
}
