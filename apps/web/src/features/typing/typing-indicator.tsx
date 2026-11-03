import { useT } from "@/i18n";
import { typingText, useTypingUsers } from "./store";

/**
 * "Fulano está digitando…" abaixo do composer. Reserva a altura da linha mesmo vazia (o texto
 * aparece e some sem empurrar a lista). `nameOf` resolve o id para o nome (membro do servidor ou
 * participante da DM); quem não se resolve vira "Alguém" (settings.typing.someone).
 */
export function TypingIndicator({
  channelId,
  nameOf,
}: {
  channelId: string;
  nameOf: (userId: string) => string | undefined;
}) {
  const { t } = useT();
  const users = useTypingUsers(channelId);
  const text = typingText(users.map((u) => nameOf(u) ?? t("settings.typing.someone")));
  return (
    <p
      aria-live="polite"
      data-testid="typing-indicator"
      className="h-4 truncate text-xs text-muted-foreground"
    >
      {text}
    </p>
  );
}
