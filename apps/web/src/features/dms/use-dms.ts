import { type ChannelPayload, useListDMs } from "@spook/shared";
import { useMemo } from "react";
import { sortByActivity } from "@/lib/dm-cache";

/** Lista de DMs (semeada pelo READY e mantida pelos eventos); atividade mais recente primeiro. */
export function useDms() {
  const q = useListDMs();
  const list: ChannelPayload[] = useMemo(() => sortByActivity(q.data ?? []), [q.data]);
  return { ...q, list };
}
