import { type MessagePayload, usePinMessage, useUnpinMessage } from "@spook/shared";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { t } from "@/i18n";
import { appMessage } from "@/lib/app-errors";
import { setPinned } from "@/lib/message-cache";
import { applyPinUpdate, removePinned } from "@/lib/pins-cache";

/**
 * Fixar/desafixar uma mensagem. O PUT/DELETE responde 204 sem corpo: o histórico e o painel são
 * atualizados na hora e o MESSAGE_UPDATE do servidor confirma (e atualiza as outras sessões).
 */
export function usePinToggle(channelId: string) {
  const qc = useQueryClient();
  const pin = usePinMessage();
  const unpin = useUnpinMessage();
  return {
    pending: pin.isPending || unpin.isPending,
    async toggle(m: MessagePayload) {
      const next = !m.pinned;
      try {
        if (next) await pin.mutateAsync({ channelId, messageId: m.id });
        else await unpin.mutateAsync({ channelId, messageId: m.id });
        setPinned(qc, channelId, m.id, next);
        if (next) applyPinUpdate(qc, channelId, { ...m, pinned: true });
        else removePinned(qc, channelId, m.id);
        toast.success(t(next ? "chat.pins.toastPinned" : "chat.pins.toastUnpinned"));
      } catch (e) {
        toast.error(appMessage(e));
      }
    },
  };
}
