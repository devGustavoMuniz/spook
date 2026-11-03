import { WifiOff } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
import { useGatewayStore } from "./store";

/** Quedas mais curtas que isso (troca de rede, resume rápido) passam sem aviso: nada de piscar. */
export const RECONNECT_NOTICE_DELAY_MS = 2_500;

export function ConnectionIndicator() {
  const { t } = useT();
  const status = useGatewayStore((s) => s.status);
  const error = useGatewayStore((s) => s.lastError);
  const retry = useGatewayStore((s) => s.retry);
  const [late, setLate] = useState(false);

  useEffect(() => {
    if (status !== "reconnecting") return;
    const t = setTimeout(() => setLate(true), RECONNECT_NOTICE_DELAY_MS);
    return () => {
      clearTimeout(t);
      setLate(false);
    };
  }, [status]);

  const takenOver = status === "closed" && error?.kind === "taken_over";
  if (!(takenOver || (status === "reconnecting" && late))) return null;

  return (
    <output className="pointer-events-auto fixed bottom-3 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full border bg-card px-3 py-1.5 text-xs text-muted-foreground shadow-md">
      <WifiOff className="size-3.5" aria-hidden />
      {takenOver ? (
        <>
          <span>{t("settings.gateway.takenOver")}</span>
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-xs"
            onClick={() => retry?.()}
          >
            {t("settings.gateway.reconnect")}
          </Button>
        </>
      ) : (
        <span>{t("settings.gateway.reconnecting")}</span>
      )}
    </output>
  );
}
