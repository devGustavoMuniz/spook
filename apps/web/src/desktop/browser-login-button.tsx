import { desktopExchange, getApiBaseUrl, getGetMeQueryKey } from "@spook/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Globe } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  BrowserLoginError,
  browserLoginEnabled,
  loginViaBrowser,
  tauriPorts,
} from "@/desktop/browser-login";
import { persistSessionToken } from "@/desktop/token";
import { messageFor } from "@/lib/errors";

/**
 * "Entrar pelo navegador" do app desktop. Só aparece no Tauri com a capability `browserLogin` ligada (lado Rust
 * do deep link pendente: ver `browser-login.ts`).
 */
export function BrowserLoginButton() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  if (!browserLoginEnabled()) return null;

  async function start() {
    setBusy(true);
    try {
      const res = await loginViaBrowser({
        baseUrl: getApiBaseUrl() || window.location.origin,
        ports: tauriPorts(async (code, verifier) => {
          const r = await desktopExchange({ code, code_verifier: verifier });
          return { token: r.token, user: r.user };
        }),
      });
      await persistSessionToken(res.token);
      qc.setQueryData(getGetMeQueryKey(), res.user);
      await navigate({ to: "/" });
    } catch (e) {
      toast.error(e instanceof BrowserLoginError ? e.message : messageFor(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="xl"
      className="w-full"
      loading={busy}
      onClick={() => void start()}
    >
      <Globe aria-hidden />
      Entrar pelo navegador
    </Button>
  );
}
