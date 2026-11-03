import { useEffect } from "react";
import { formatBadge } from "@/i18n";
import { useTotalMentions } from "./badges";

const BASE = "Spook";

/** Título da aba: "(3) Spook" com o total de menções (e mensagens de DM) não lidas. */
export const titleFor = (mentions: number) =>
  mentions > 0 ? `(${formatBadge(mentions)}) ${BASE}` : BASE;

export function useUnreadTitle() {
  const mentions = useTotalMentions();
  useEffect(() => {
    document.title = titleFor(mentions);
  }, [mentions]);
  useEffect(
    () => () => {
      document.title = BASE;
    },
    [],
  );
}
