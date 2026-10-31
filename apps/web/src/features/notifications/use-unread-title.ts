import { useEffect } from "react";
import { useTotalMentions } from "./badges";
import { formatCount } from "./read-state";

const BASE = "Spook";

/** Título da aba: "(3) Spook" com o total de menções (e mensagens de DM) não lidas. */
export const titleFor = (mentions: number) =>
  mentions > 0 ? `(${formatCount(mentions)}) ${BASE}` : BASE;

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
