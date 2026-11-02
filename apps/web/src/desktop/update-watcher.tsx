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
import { updater as appUpdater, type Updater } from "./updater";

const TOAST_ID = "app-update";

/**
 * Montado só no desktop: verifica de tempos em tempos, avisa com um toast discreto quando a nova versão já está
 * baixada ("Reiniciar para atualizar") e pede confirmação antes de reiniciar com uma chamada de voz em andamento.
 */
export function UpdateWatcher({ updater = appUpdater }: { updater?: Updater }) {
  const status = updater.useStore((s) => s.status);
  const confirm = updater.useStore((s) => s.confirmRestart);
  const announced = useRef<string | null>(null);

  useEffect(() => updater.startPeriodicChecks(), [updater]);

  useEffect(() => {
    if (status.kind !== "ready" || announced.current === status.version) return;
    announced.current = status.version;
    toast(`Spook ${status.version} está pronto`, {
      id: TOAST_ID,
      description: "Reinicie o app para usar a nova versão.",
      duration: Number.POSITIVE_INFINITY,
      action: { label: "Reiniciar para atualizar", onClick: () => void updater.requestRestart() },
    });
  }, [status, updater]);

  return (
    <AlertDialog open={confirm} onOpenChange={(open) => !open && updater.dismissRestart()}>
      <AlertDialogContent>
        <AlertDialogTitle>Reiniciar durante a chamada?</AlertDialogTitle>
        <AlertDialogDescription>
          Você está em uma chamada de voz. Ao reiniciar para atualizar, a chamada é encerrada. Você
          pode deixar para depois: o app se atualiza na próxima vez que abrir.
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel>Agora não</AlertDialogCancel>
          <AlertDialogAction onClick={() => void updater.confirmRestartNow()}>
            Reiniciar e sair da chamada
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
