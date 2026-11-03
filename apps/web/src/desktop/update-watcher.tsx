import { useEffect, useRef } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { t, useT } from "@/i18n";
import { updater as appUpdater, type Updater } from "./updater";

const TOAST_ID = "app-update";

/**
 * Montado só no desktop: verifica de tempos em tempos, avisa com um toast discreto quando a nova versão já está
 * baixada ("Reiniciar para atualizar") e pede confirmação antes de reiniciar com uma chamada de voz em andamento.
 */
export function UpdateWatcher({ updater = appUpdater }: { updater?: Updater }) {
  const { t: tr } = useT();
  const status = updater.useStore((s) => s.status);
  const confirm = updater.useStore((s) => s.confirmRestart);
  const announced = useRef<string | null>(null);

  useEffect(() => updater.startPeriodicChecks(), [updater]);

  useEffect(() => {
    if (status.kind !== "ready" || announced.current === status.version) return;
    announced.current = status.version;
    toast(t("settings.watcher.toastTitle", { version: status.version }), {
      id: TOAST_ID,
      description: t("settings.watcher.toastDescription"),
      duration: Number.POSITIVE_INFINITY,
      action: {
        label: t("settings.updates.restart"),
        onClick: () => void updater.requestRestart(),
      },
    });
  }, [status, updater]);

  return (
    <AlertDialog open={confirm} onOpenChange={(open) => !open && updater.dismissRestart()}>
      <AlertDialogContent>
        <AlertDialogTitle>{tr("settings.watcher.confirmTitle")}</AlertDialogTitle>
        <AlertDialogDescription>{tr("settings.watcher.confirmDescription")}</AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel>{tr("settings.watcher.notNow")}</AlertDialogCancel>
          <AlertDialogAction onClick={() => void updater.confirmRestartNow()}>
            {tr("settings.watcher.restartAndLeave")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
