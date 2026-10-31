import { useOpenDM } from "@spook/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { dmMessage } from "@/lib/app-errors";
import { upsertDM } from "@/lib/dm-cache";

/** Abre (ou cria) a DM 1:1 com alguém e vai para ela; reabrir devolve a mesma conversa. */
export function useStartDm() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const open = useOpenDM();
  async function startDm(userId: string) {
    try {
      const ch = await open.mutateAsync({ data: { recipient_id: userId } });
      upsertDM(qc, ch);
      await navigate({ to: "/channels/@me/$channelId", params: { channelId: ch.id } });
    } catch (e) {
      toast.error(dmMessage(e, "open"));
    }
  }
  return { startDm, pending: open.isPending };
}
