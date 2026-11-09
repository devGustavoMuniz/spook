import { ImagePlus } from "lucide-react";
import { type ClipboardEvent, type DragEvent, useId, useRef } from "react";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
import { PendingAttachments } from "../attachments/pending-attachments";
import { TICKET_ACCEPT, TICKET_MAX_FILES } from "./attachments";
import type { TicketAttachments } from "./use-ticket-attachments";

/**
 * Props para a área que aceita imagens coladas (Ctrl+V) e arrastadas. Colar texto continua normal: só os
 * arquivos de imagem da área de transferência são capturados.
 */
export function attachmentDropProps(att: Pick<TicketAttachments, "addFiles">) {
  return {
    onPaste(e: ClipboardEvent) {
      const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
      if (files.length === 0) return;
      e.preventDefault();
      att.addFiles(files);
    },
    onDragOver(e: DragEvent) {
      if ([...e.dataTransfer.types].includes("Files")) e.preventDefault();
    },
    onDrop(e: DragEvent) {
      if (e.dataTransfer.files.length === 0) return;
      e.preventDefault();
      att.addFiles([...e.dataTransfer.files]);
    },
  };
}

/** Botão "Anexar imagens", dica de limites e a lista de imagens pendentes (progresso, erro, remover). */
export function AttachmentPicker({ att }: { att: TicketAttachments }) {
  const { t } = useT();
  const input = useRef<HTMLInputElement>(null);
  const hintId = useId();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={att.items.length >= TICKET_MAX_FILES}
          aria-describedby={hintId}
          onClick={() => input.current?.click()}
        >
          <ImagePlus aria-hidden /> {t("feedback.attach.add")}
        </Button>
        <span id={hintId} className="text-xs text-muted-foreground">
          {t("feedback.attach.hint", { max: TICKET_MAX_FILES })}
        </span>
        <input
          ref={input}
          type="file"
          accept={TICKET_ACCEPT}
          multiple
          hidden
          aria-label={t("feedback.attach.add")}
          onChange={(e) => {
            att.addFiles([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
      </div>
      <PendingAttachments
        items={att.items}
        onRemove={(id) => att.queue.remove(id)}
        onRetry={(id) => att.queue.retry(id)}
      />
    </div>
  );
}
