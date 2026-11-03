// Montado só no desktop (ver `main.tsx`): contador no ícone do app e "clicar na notificação abre o canal".
import { useEffect } from "react";
import { useTotalMentions } from "@/features/notifications/badges";
import { useLocale } from "@/i18n";
import { appBadge, installNotificationClick, setNativeLocale } from "./shell";

export function DesktopShell({ navigate }: { navigate: (url: string) => void }) {
  // Mesmo número do título da aba, "(N) Spook": menções + mensagens de DM não lidas.
  const unread = useTotalMentions();
  useEffect(() => {
    appBadge.set(unread);
  }, [unread]);
  // Ao desmontar (fim da sessão do app) limpa o contador na hora.
  useEffect(() => () => appBadge.flush(0), []);
  // O Rust monta o menu da bandeja e o aviso "continua rodando": ele precisa saber o idioma ativo.
  const locale = useLocale();
  useEffect(() => {
    void setNativeLocale(locale);
  }, [locale]);
  useEffect(() => installNotificationClick(navigate), [navigate]);
  return null;
}
