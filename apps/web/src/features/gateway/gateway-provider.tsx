import { GatewayClient, type GatewayEvent } from "@spook/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { type ReactNode, useEffect } from "react";
import { toast } from "sonner";
import { gatewayConnection } from "@/desktop/connection";
import { t } from "@/i18n";
import { useFeedbackFocus } from "../feedback/focus-store";
import { showInAppNotification } from "../notifications/notify";
import { useReadStateStore } from "../notifications/read-state";
import { useNotificationSettings } from "../notifications/settings";
import { cancelReloadReadStates } from "../notifications/sync";
import { resetAckMemory } from "../notifications/use-auto-ack";
import { pageActive, useViewportStore, viewingOf } from "../notifications/viewport";
import { watchIdle } from "../presence/idle-detector";
import { usePresenceStore } from "../presence/store";
import { openSettingsIn } from "../settings/use-settings";
import { useCallStore } from "../social/call-store";
import { useSocialStore } from "../social/store";
import { useTypingStore } from "../typing/store";
import { leaveOnPageHide, shutdownVoice } from "../voice/controller";
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
        toast.info(
          name ? t("settings.gateway.leftGuildNamed", { name }) : t("settings.gateway.leftGuild"),
        );
        void router.navigate({ to: "/", replace: true });
      },
      channelGone: (guildId, name) => {
        toast.info(
          name
            ? t("settings.gateway.channelGoneNamed", { name })
            : t("settings.gateway.channelGone"),
        );
        void router.navigate({ to: "/channels/$guildId", params: { guildId }, replace: true });
      },
      dmGone: (title) => {
        toast.info(
          title ? t("settings.gateway.dmGoneNamed", { title }) : t("settings.gateway.dmGone"),
        );
        void router.navigate({ to: "/channels/@me", replace: true });
      },
      viewing: (channelId) => viewingOf(channelId, useViewportStore.getState(), pageActive()),
      notify: (n) => showInAppNotification(n, (url) => void router.navigate({ href: url })),
      ticketUpdated: (ticket) => {
        const key =
          ticket.status === "resolved"
            ? "feedback.notify.resolved"
            : ticket.status === "closed"
              ? "feedback.notify.closed"
              : "feedback.notify.replied";
        toast.info(t(key), {
          description: ticket.title,
          action: {
            label: t("feedback.notify.open"),
            onClick: () => {
              useFeedbackFocus.getState().focus(ticket.id);
              void openSettingsIn(router, "feedback");
            },
          },
        });
      },
    };

    const client = new GatewayClient({
      ...gatewayConnection(),
      socketFactory: gatewaySocketFactory(),
      onStatusChange: (s) => useGatewayStore.getState().setStatus(s),
      onReady: (ready) => {
        useGatewayStore.getState().setSession(ready.session_id, ready.user.id);
        // Em reconexão o onInvalidated (logo depois) refaz o resto; aqui entra a lista nova de servidores.
        applyReady(qc, ready, fx);
        // O snapshot não traz o próprio usuário: ele se vê pelo estado que o detector sinaliza.
        const presence = usePresenceStore.getState();
        presence.replaceAll(ready.presences);
        presence.set(ready.user.id, client.presence);
        presence.setMine(ready.user.id, ready.self_presence);
        useNotificationSettings.getState().replaceAll(ready.notification_settings ?? []);
        useTypingStore.getState().reset();
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

    // Ausente após 10 min sem interação (medido aqui; o servidor só guarda o que sinalizamos).
    const stopIdle = watchIdle((status) => {
      client.setPresence(status);
      const me = useGatewayStore.getState().userId;
      if (me) usePresenceStore.getState().set(me, status);
    });

    const wake = () => {
      if (document.visibilityState === "visible") client.reconnectNow();
    };
    const online = () => client.reconnectNow();
    const offline = () => client.notifyOffline();
    window.addEventListener("pagehide", leaveOnPageHide);
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    document.addEventListener("visibilitychange", wake);
    return () => {
      window.removeEventListener("pagehide", leaveOnPageHide);
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
      document.removeEventListener("visibilitychange", wake);
      stopIdle();
      client.close();
      useGatewayStore.getState().reset();
      usePresenceStore.getState().reset();
      useTypingStore.getState().reset();
      useSocialStore.getState().reset();
      useCallStore.getState().reset();
      useReadStateStore.getState().reset();
      useNotificationSettings.getState().reset();
      cancelReloadReadStates();
      resetAckMemory();
      shutdownVoice();
    };
  }, [qc, router]);

  return (
    <>
      {children}
      <ConnectionIndicator />
    </>
  );
}
