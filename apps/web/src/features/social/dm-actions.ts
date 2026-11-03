import { type ChannelPayload, useGetMe, useOpenDM } from "@spook/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { dmTitle } from "@/features/dms/dm-utils";
import { dmMessage } from "@/lib/app-errors";
import { upsertDM } from "@/lib/dm-cache";
import { placeCall } from "./call-actions";

/** "Enviar mensagem" e "Ligar" a partir de uma pessoa (tela de Amigos e cartão de perfil). */
export function useDmActions() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const open = useOpenDM();
  const { data: me } = useGetMe();

  async function openChannel(userId: string): Promise<ChannelPayload | null> {
    try {
      const ch = await open.mutateAsync({ data: { recipient_id: userId } });
      upsertDM(qc, ch);
      await navigate({ to: "/channels/@me/$channelId", params: { channelId: ch.id } });
      return ch;
    } catch (e) {
      toast.error(dmMessage(e, "open"));
      return null;
    }
  }

  return {
    pending: open.isPending,
    message: async (userId: string) => {
      await openChannel(userId);
    },
    call: async (userId: string) => {
      if (!me) return;
      const ch = await openChannel(userId);
      if (ch) await placeCall(ch.id, dmTitle(ch, me.id));
    },
  };
}
