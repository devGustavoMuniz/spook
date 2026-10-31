import { useCallback } from "react";
import { toast } from "sonner";
import { useUploadQueue } from "./use-upload-queue";

const SHOWN = 3;

/** Mostra os avisos de arquivos recusados (até 3, mais um resumo). */
export function toastRejected(rejected: string[]) {
  for (const msg of rejected.slice(0, SHOWN)) toast.error(msg);
  if (rejected.length > SHOWN)
    toast.error(`E mais ${rejected.length - SHOWN} arquivo(s) recusado(s).`);
}

/**
 * Anexos de um canal: fila de uploads + entrada de arquivos (botão, arrastar e soltar, colar), com
 * a regra de permissão (ATTACH_FILES) num lugar só.
 */
export function useComposerAttachments(channelId: string, canAttach: boolean) {
  const { queue, items } = useUploadQueue(channelId);
  const addFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      if (!canAttach) {
        toast.error("Você não tem permissão para anexar arquivos neste canal.");
        return;
      }
      toastRejected(queue.add(files).rejected);
    },
    [queue, canAttach],
  );
  return { queue, items, addFiles, canAttach };
}

export type ComposerAttachments = ReturnType<typeof useComposerAttachments>;
