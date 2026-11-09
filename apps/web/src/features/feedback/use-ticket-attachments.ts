import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { t } from "@/i18n";
import { putWithProgress } from "@/lib/upload";
import { UploadQueue } from "../attachments/upload-queue";
import { toastRejected } from "../attachments/use-composer-attachments";
import {
  createTicketUploader,
  nameCapture,
  ticketQueueRules,
  ticketUploadError,
} from "./attachments";

/**
 * Imagens de uma mensagem de chamado: fila de uploads (a mesma das mensagens do chat) + entrada de arquivos.
 * Sem `ticketId` é um chamado novo (o primeiro upload reserva o ID). Trocar de chamado descarta os pendentes.
 */
export function useTicketAttachments(ticketId?: string) {
  const uploader = useMemo(() => createTicketUploader(ticketId), [ticketId]);
  const queue = useMemo(
    () =>
      new UploadQueue(ticketId ?? "draft", {
        requestUpload: uploader.requestUpload,
        put: putWithProgress,
        rules: ticketQueueRules,
        describeError: ticketUploadError,
        createPreviewUrl: (f) => URL.createObjectURL(f),
        revokePreviewUrl: (u) => URL.revokeObjectURL(u),
      }),
    [ticketId, uploader],
  );
  useEffect(() => () => queue.clear(), [queue]);
  const items = useSyncExternalStore(queue.subscribe, queue.getSnapshot);
  const seq = useRef(0);

  const addFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      const named = files.map((f) => nameCapture(f, ++seq.current));
      toastRejected(queue.add(named).rejected);
    },
    [queue],
  );

  /** Confere se dá para enviar o formulário; devolve os ids dos anexos prontos ou `null` (e avisa o porquê). */
  const readyIds = useCallback((): string[] | null => {
    if (queue.busy) {
      toast.error(t("feedback.attach.wait"));
      return null;
    }
    if (queue.hasError) {
      toast.error(t("feedback.attach.fix"));
      return null;
    }
    return queue.uploadIds();
  }, [queue]);

  /** Mensagem enviada: limpa a fila e, em chamado novo, começa outro rascunho. */
  const done = useCallback(() => {
    queue.clear();
    uploader.reset();
  }, [queue, uploader]);

  /**
   * O servidor recusou a mensagem por causa dos anexos (apagou ou não achou o objeto): os ids não valem mais,
   * então tudo volta a "erro" (tentar de novo pede uploads novos, num rascunho novo).
   */
  const rejected = useCallback(
    (message: string) => {
      queue.invalidateAll(message);
      uploader.reset();
    },
    [queue, uploader],
  );

  return { queue, items, addFiles, readyIds, done, rejected, getDraftId: uploader.getDraftId };
}

export type TicketAttachments = ReturnType<typeof useTicketAttachments>;
