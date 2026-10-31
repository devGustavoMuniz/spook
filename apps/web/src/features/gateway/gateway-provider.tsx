import { GatewayClient, type GatewayEvent, gatewayUrl } from "@spook/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { type ReactNode, useEffect } from "react";
import { toast } from "sonner";
import {
  applyGatewayEvent,
  applyReady,
  type GatewayEffects,
  refreshAfterGap,
} from "./cache-bindings";
import { ConnectionIndicator } from "./connection-indicator";
import { gatewaySocketFactory } from "./socket";
import { useGatewayStore } from "./store";

/**
 * Mantém a conexão com o gateway enquanto a área autenticada está montada: conecta ao logar,
 * desconecta ao sair e reconecta quando a internet volta ou a aba fica visível de novo.
 */
export function GatewayProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const router = useRouter();

  useEffect(() => {
    const store = useGatewayStore.getState();
    const fx: GatewayEffects = {
      myId: () => useGatewayStore.getState().userId,
      location: () => {
        const params: { guildId?: string; channelId?: string } = {};
        for (const m of router.state.matches) Object.assign(params, m.params);
        return params;
      },
      leftGuild: (name) => {
        toast.info(name ? `Você não está mais em ${name}.` : "Você não está mais neste servidor.");
        void router.navigate({ to: "/", replace: true });
      },
      channelGone: (guildId, name) => {
        toast.info(
          name
            ? `O canal #${name} não está mais disponível.`
            : "Este canal não está mais disponível.",
        );
        void router.navigate({ to: "/channels/$guildId", params: { guildId }, replace: true });
      },
    };

    const client = new GatewayClient({
      url: gatewayUrl(window.location.origin),
      client: "web",
      socketFactory: gatewaySocketFactory(),
      onStatusChange: (s) => useGatewayStore.getState().setStatus(s),
      onReady: (ready) => {
        useGatewayStore.getState().setSession(ready.session_id, ready.user.id);
        // Em reconexão o onInvalidated (logo depois) refaz o resto; aqui entra a lista nova de servidores.
        applyReady(qc, ready.guilds, fx);
      },
      onResumed: (r) => useGatewayStore.getState().setSession(r.session_id),
      onInvalidated: () => refreshAfterGap(qc),
      onError: (e) => useGatewayStore.getState().setError(e),
    });
    client.onEvent((ev: GatewayEvent) => applyGatewayEvent(qc, fx, ev));

    store.setRetry(() => {
      store.setError(null);
      client.connect();
      refreshAfterGap(qc); // ficou fora do ar: o que está no cache pode estar velho
    });
    client.connect();

    const wake = () => {
      if (document.visibilityState === "visible") client.reconnectNow();
    };
    const online = () => client.reconnectNow();
    const offline = () => client.notifyOffline();
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    document.addEventListener("visibilitychange", wake);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
      document.removeEventListener("visibilitychange", wake);
      client.close();
      useGatewayStore.getState().reset();
    };
  }, [qc, router]);

  return (
    <>
      {children}
      <ConnectionIndicator />
    </>
  );
}
