import { desktopExchange, getApiBaseUrl, getGetMeQueryKey, isApiError } from "@spook/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Globe } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  BrowserLoginError,
  browserLoginEnabled,
  loginViaBrowser,
  tauriPorts,
} from "@/desktop/browser-login";
import { persistSessionToken } from "@/desktop/token";
import { useT } from "@/i18n";
import { messageFor } from "@/lib/errors";

/**
 * "Entrar pelo navegador" do app desktop. Só aparece no Tauri com a capability `browserLogin` ligada (build do
 * desktop). Estados: ocioso, aguardando (com "Cancelar"), erro (tempo esgotado, código expirado/usado ou falha)
 * e, no sucesso, a sessão é gravada no chaveiro e a pessoa vai para o app.
 */
export function BrowserLoginButton() {
  const { t } = useT();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Sair da tela (ou do app) no meio do fluxo para de escutar o deep link.
  useEffect(() => () => abortRef.current?.abort(), []);
  if (!browserLoginEnabled()) return null;

  async function start() {
    const ctl = new AbortController();
    abortRef.current = ctl;
    setBusy(true);
    setError(null);
    try {
      const res = await loginViaBrowser({
        baseUrl: getApiBaseUrl() || window.location.origin,
        signal: ctl.signal,
        ports: tauriPorts(async (code, verifier) => {
          const r = await desktopExchange({ code, code_verifier: verifier });
          return { token: r.token, user: r.user };
        }),
      });
      await persistSessionToken(res.token);
      qc.setQueryData(getGetMeQueryKey(), res.user);
      await navigate({ to: "/" });
    } catch (e) {
      // Cancelar é uma escolha da pessoa, não um erro.
      if (!(e instanceof BrowserLoginError && e.reason === "cancelled")) {
        setError(
          e instanceof BrowserLoginError
            ? e.message
            : isApiError(e)
              ? messageFor(e)
              : t("auth.browserLogin.error"),
        );
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  }

  return (
    <div className="flex w-full flex-col gap-2">
      {busy ? (
        <>
          <output className="block text-center text-sm text-muted-foreground">
            {t("auth.browserLogin.waiting")}
          </output>
          <p className="text-center text-xs text-muted-foreground">{t("auth.browserLogin.hint")}</p>
          <Button
            type="button"
            variant="outline"
            size="xl"
            className="w-full"
            onClick={() => abortRef.current?.abort()}
          >
            {t("auth.browserLogin.cancel")}
          </Button>
        </>
      ) : (
        <>
          {error && (
            <p role="alert" className="text-center text-sm text-destructive">
              {error}
            </p>
          )}
          <Button
            type="button"
            variant="outline"
            size="xl"
            className="w-full"
            onClick={() => void start()}
          >
            <Globe aria-hidden />
            {t("auth.browserLogin")}
          </Button>
        </>
      )}
    </div>
  );
}
