import { useListGuilds } from "@spook/shared";
import { Outlet } from "@tanstack/react-router";
import { useSessionGuard } from "@/components/app-shell";
import { TooltipProvider } from "@/components/ui/tooltip";
import { GatewayProvider } from "@/features/gateway/gateway-provider";
import { ServerRail } from "@/features/guilds/server-rail";
import { useUnreadTitle } from "@/features/notifications/use-unread-title";
import { usePushSync } from "@/features/push/use-push";

/** Área autenticada: barra de servidores à esquerda e a tela atual ao lado. */
export function AuthedLayout() {
  useSessionGuard();
  useUnreadTitle();
  usePushSync();
  const guilds = useListGuilds();
  return (
    <TooltipProvider delayDuration={200}>
      <GatewayProvider>
        <div className="flex h-svh flex-col">
          <div className="flex min-h-0 flex-1">
            <ServerRail guilds={guilds.data ?? []} />
            <div className="min-w-0 flex-1">
              <Outlet />
            </div>
          </div>
        </div>
      </GatewayProvider>
    </TooltipProvider>
  );
}
