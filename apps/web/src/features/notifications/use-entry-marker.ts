import { useState } from "react";
import { useReadStateStore } from "./read-state";
import { isZeroId } from "./snowflake";

/**
 * Ponto de leitura de quando o canal foi aberto, para o separador "Novas mensagens": só existe se havia
 * não lidas e o ponto de leitura é conhecido. Fixo enquanto o canal fica aberto (ler não faz o separador
 * sumir sob os olhos do usuário). Espera o snapshot de não lidas chegar (READY ou GET).
 */
export function useEntryMarker(channelId: string): string | null {
  const loaded = useReadStateStore((s) => s.loaded);
  const [marker, setMarker] = useState<{ channelId: string; after: string | null } | null>(null);
  if (loaded && marker?.channelId !== channelId) {
    const c = useReadStateStore.getState().channels[channelId];
    setMarker({
      channelId,
      after: c && c.unread > 0 && !isZeroId(c.lastRead) ? c.lastRead : null,
    });
  }
  return marker?.channelId === channelId ? marker.after : null;
}
