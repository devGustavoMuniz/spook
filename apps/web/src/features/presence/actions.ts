import { type PresenceUpdateBody, updateMyPresence } from "@spook/shared";
import { toast } from "sonner";
import { appMessage } from "@/lib/app-errors";
import { usePresenceStore } from "./store";

/**
 * PATCH /users/@me/presence. A resposta já atualiza a minha preferência (as outras abas recebem
 * PRESENCE_SELF_UPDATE). Devolve se deu certo; o erro aparece num aviso.
 */
export async function updatePresence(body: PresenceUpdateBody): Promise<boolean> {
  try {
    const self = await updateMyPresence(body);
    const s = usePresenceStore.getState();
    s.setMine(s.meId, self);
    return true;
  } catch (e) {
    toast.error(appMessage(e));
    return false;
  }
}

/** Opções de expiração do status personalizado. `null` = não limpar. */
export const EXPIRY_OPTIONS = [
  { value: "never", label: "Não limpar" },
  { value: "30m", label: "30 minutos" },
  { value: "1h", label: "1 hora" },
  { value: "4h", label: "4 horas" },
  { value: "today", label: "Hoje" },
] as const;
export type ExpiryChoice = (typeof EXPIRY_OPTIONS)[number]["value"];

/** Instante (ISO) da expiração; "hoje" = meia-noite local, no máximo 24 h à frente. */
export function expiryFor(choice: ExpiryChoice, now = new Date()): string | undefined {
  const min = 60_000;
  switch (choice) {
    case "never":
      return undefined;
    case "30m":
      return new Date(now.getTime() + 30 * min).toISOString();
    case "1h":
      return new Date(now.getTime() + 60 * min).toISOString();
    case "4h":
      return new Date(now.getTime() + 240 * min).toISOString();
    case "today": {
      const end = new Date(now);
      end.setHours(24, 0, 0, 0);
      return end.toISOString();
    }
  }
}
