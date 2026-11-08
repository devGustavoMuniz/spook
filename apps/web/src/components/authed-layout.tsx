import { useListGuilds } from "@spook/shared";
import { Outlet } from "@tanstack/react-router";
import { useState } from "react";
import { useSessionGuard } from "@/components/app-shell";
import { NavDrawer, ShellProvider, useShell } from "@/components/shell";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConfirmPasswordProvider } from "@/features/account/confirm-password";
import { VerifyEmailBanner } from "@/features/account/verify-banner";
import { GatewayProvider } from "@/features/gateway/gateway-provider";
import { ServerRail } from "@/features/guilds/server-rail";
import { useUnreadTitle } from "@/features/notifications/use-unread-title";
import { usePushSync } from "@/features/push/use-push";
import { SettingsModal } from "@/features/settings/settings-modal";
import { IncomingCalls } from "@/features/social/incoming-call";
import type { Guild } from "@/lib/guild";

/**
 * Área autenticada: barra de servidores à esquerda e a tela atual ao lado. Abaixo de 768 px a barra
 * (e a lista de canais/DMs, que a tela monta via `ShellSidebar`) vira um drawer; o conteúdo ocupa a tela.
 */
export function AuthedLayout() {
  useSessionGuard();
  useUnreadTitle();
  usePushSync();
  const guilds = useListGuilds();
  const [navSlot, setNavSlot] = useState<HTMLElement | null>(null);
  return (
    <TooltipProvider delayDuration={120}>
      <GatewayProvider>
        <ConfirmPasswordProvider>
          <ShellProvider navSlot={navSlot}>
            <Frame guilds={guilds.data ?? []} onSlot={setNavSlot} />
            <IncomingCalls />
          </ShellProvider>
        </ConfirmPasswordProvider>
      </GatewayProvider>
    </TooltipProvider>
  );
}

function Frame({ guilds, onSlot }: { guilds: Guild[]; onSlot: (el: HTMLElement | null) => void }) {
  const shell = useShell();
  const compact = !!shell?.compact;
  const rail = <ServerRail guilds={guilds} />;
  return (
    <div className="relative flex h-dvh flex-col overflow-hidden pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      <VerifyEmailBanner />
      <div className="flex min-h-0 flex-1">
        {compact ? null : rail}
        <div className="min-w-0 flex-1" inert={compact && shell?.navOpen}>
          <Outlet />
        </div>
      </div>
      <NavDrawer rail={rail} onSlot={onSlot} />
      <SettingsModal />
    </div>
  );
}
