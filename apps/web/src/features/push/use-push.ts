import { isApiError } from "@spook/shared";
import { useCallback, useEffect, useState } from "react";
import { isTauri } from "@/desktop/runtime";
import { t } from "@/i18n";
import {
  detectPushStatus,
  disablePush,
  enablePush,
  type PushStatus,
  syncPushSubscription,
} from "./push";

function errorText(e: unknown): string {
  if (isApiError(e)) {
    if (e.status === 409) return t("settings.push.tooMany");
    if (e.status === 422) return t("settings.push.badSubscription");
    if (e.status === 429) return t("settings.push.rateLimited");
    if (e.status === 503) return t("settings.push.serverOff");
  }
  return t("settings.push.failed");
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
