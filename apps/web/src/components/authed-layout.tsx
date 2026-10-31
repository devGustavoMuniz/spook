import { useListGuilds } from "@spook/shared";
import { Outlet } from "@tanstack/react-router";
import { useSessionGuard } from "@/components/app-shell";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ServerRail } from "@/features/guilds/server-rail";

/** Área autenticada: barra de servidores à esquerda e a tela atual ao lado. */
export function AuthedLayout() {
  useSessionGuard();
  const guilds = useListGuilds();
  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-svh">
        <ServerRail guilds={guilds.data ?? []} />
        <div className="min-w-0 flex-1">
          <Outlet />
        </div>
      </div>
    </TooltipProvider>
  );
}
