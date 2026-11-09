import type { TicketContext } from "@spook/shared";
import { useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { isTauri } from "@/desktop/runtime";
import { updater } from "@/desktop/updater";
import { getLocale } from "@/i18n";

type UAData = { platform?: string };

/** Sistema operacional em texto curto (sem versão detalhada, sem identificadores do aparelho). */
export function detectOS(nav: Pick<Navigator, "userAgent"> & { userAgentData?: UAData }): string {
  const hint = nav.userAgentData?.platform;
  if (hint) return hint.slice(0, 64);
  const ua = nav.userAgent;
  if (/Windows/i.test(ua)) return "Windows";
  if (/Android/i.test(ua)) return "Android";
  if (/iPhone|iPad|iPod/i.test(ua)) return "iOS";
  if (/Mac OS X|Macintosh/i.test(ua)) return "macOS";
  if (/Linux|X11/i.test(ua)) return "Linux";
  return "";
}

/** Contexto técnico que acompanha o chamado (o usuário vê tudo isto antes de enviar e pode desligar). */
export function buildTechContext(route: string, desktopVersion?: string): TicketContext {
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  return {
    app_version: desktopVersion ?? __APP_VERSION__,
    client: isTauri() ? "desktop" : "web",
    os: nav ? detectOS(nav as Navigator & { userAgentData?: UAData }) : "",
    browser: nav ? nav.userAgent.slice(0, 160) : "",
    route: route.slice(0, 200),
    locale: getLocale(),
  };
}

/** `buildTechContext` com a rota atual do app e, no desktop, a versão nativa (lida do Tauri). */
export function useTechContext(): TicketContext {
  const route = useRouterState({ select: (s) => s.location.pathname });
  const [desktopVersion, setDesktopVersion] = useState<string>();
  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    updater
      .currentVersion()
      .then((v) => alive && setDesktopVersion(v))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return buildTechContext(route, desktopVersion);
}
