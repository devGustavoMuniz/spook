import { useRouter } from "@tanstack/react-router";
import { useCallback } from "react";
import { openSettingsIn } from "@/features/settings/use-settings";

/** Abre Configurações > Nitro (sem roteador, como em testes isolados, cai para o endereço público). */
export function useOpenNitro(): () => void {
  const router = useRouter({ warn: false });
  return useCallback(() => {
    if (router) void openSettingsIn(router, "nitro");
    else window.location.assign("/settings/nitro");
  }, [router]);
}
