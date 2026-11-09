import { useEffect, useState } from "react";
import { useFeedbackFocus } from "./focus-store";
import { NewTicketCard } from "./new-ticket-form";
import { TicketListCard } from "./ticket-list";
import { TicketThread } from "./ticket-thread";

/** Configurações > Ajuda e feedback: novo chamado, meus chamados e a conversa de cada um. */
export function FeedbackPage() {
  const [openId, setOpenId] = useState<string | null>(null);
  const focused = useFeedbackFocus((s) => s.ticketId);
  const clear = useFeedbackFocus((s) => s.clear);
  // O aviso "a equipe respondeu" abre direto a conversa.
  useEffect(() => {
    if (focused) {
      setOpenId(focused);
      clear();
    }
  }, [focused, clear]);

  if (openId) return <TicketThread id={openId} onBack={() => setOpenId(null)} />;
  return (
    <>
      <NewTicketCard onCreated={setOpenId} />
      <TicketListCard onOpen={setOpenId} />
    </>
  );
}
