import { RotateCw, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { isTauri } from "@/desktop/runtime";
import { currentBuild, fetchRemoteBuild, isNewerBuild } from "./version-check";

/** Intervalo entre verificações com a aba aberta. */
export const VERSION_CHECK_INTERVAL_MS = 10 * 60 * 1000;
/** Voltar o foco várias vezes seguidas não consulta o servidor de novo antes disso. */
export const VERSION_FOCUS_THROTTLE_MS = 30 * 1000;

/**
 * Consulta `/version.json` ao voltar o foco e a cada ~10 min; se o build do servidor for outro, mostra um banner
 * discreto "Nova versão disponível — Recarregar". Não recarrega sozinho (não interrompe quem está digitando) e não
 * roda em desenvolvimento nem no app desktop (que se atualiza pelo updater).
 */
export function VersionWatcher({ enabled = !import.meta.env.DEV && !isTauri() }) {
  const [stale, setStale] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!enabled || stale) return;
    const local = currentBuild();
    let last = 0;
    let alive = true;
    const run = async () => {
      last = Date.now();
      const remote = await fetchRemoteBuild();
      if (alive && remote && isNewerBuild(local, remote)) setStale(true);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - last >= VERSION_FOCUS_THROTTLE_MS)
        void run();
    };
    const timer = setInterval(() => void run(), VERSION_CHECK_INTERVAL_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [enabled, stale]);

  if (!stale || dismissed) return null;
  return (
    <div className="pointer-events-none fixed inset-x-4 bottom-4 z-[var(--z-toast)] flex justify-center pb-[env(safe-area-inset-bottom)]">
      <output className="pointer-events-auto flex w-full max-w-md items-center gap-2 rounded-xl border border-border bg-popover py-2 pr-2 pl-4 text-sm text-popover-foreground shadow-lg motion-safe:animate-slide-in">
        <span className="min-w-0 flex-1 text-pretty">Nova versão disponível.</span>
        <Button size="sm" onClick={() => window.location.reload()}>
          <RotateCw aria-hidden /> Recarregar
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Dispensar aviso de nova versão"
          onClick={() => setDismissed(true)}
        >
          <X aria-hidden />
        </Button>
      </output>
    </div>
  );
}
