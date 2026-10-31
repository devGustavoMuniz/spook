import { isApiError } from "@spook/shared";
import { useCallback, useEffect, useState } from "react";
import { isTauri } from "@/desktop/runtime";
import {
  detectPushStatus,
  disablePush,
  enablePush,
  type PushStatus,
  syncPushSubscription,
} from "./push";

function errorText(e: unknown): string {
  if (isApiError(e)) {
    if (e.status === 409)
      return "Você já tem notificações ativas em 10 dispositivos. Desative em outro para continuar.";
    if (e.status === 422) return "O navegador devolveu uma inscrição que o servidor não aceita.";
    if (e.status === 429) return "Muitas tentativas. Aguarde um instante e tente de novo.";
    if (e.status === 503) return "As notificações push estão desligadas neste servidor.";
  }
  return "Não foi possível mudar as notificações agora. Tente de novo.";
}

/** Estado e ações do push para a tela de configurações. */
export function usePushSettings() {
  const [status, setStatus] = useState<PushStatus>("checking");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void detectPushStatus().then((s) => alive && setStatus(s));
    return () => {
      alive = false;
    };
  }, []);

  const enable = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await enablePush());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const disable = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await disablePush();
      setStatus("inactive");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }, []);

  return { status, busy, error, enable, disable };
}

/** Ao entrar na área autenticada, reenvia a inscrição que o navegador já tem (sem pedir nada). */
export function usePushSync() {
  useEffect(() => {
    if (isTauri()) return; // desktop: notificações nativas, sem Web Push
    void syncPushSubscription().catch(() => {});
  }, []);
}
