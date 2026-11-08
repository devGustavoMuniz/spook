import { useRouter, useRouterState } from "@tanstack/react-router";
import { type ComponentProps, useCallback } from "react";
import { NAV_COMPACT_QUERY, useMediaQuery } from "@/components/shell";
import { loadLastSection, saveLastSection } from "./return-path";
import { parseView, type SectionKey, type SettingsView, sectionOf } from "./sections";

/** Endereço público de cada visão do modal (é só a máscara da URL; o app atrás continua na rota de sempre). */
export const settingsHref = (view: SettingsView) =>
  view === "menu" ? "/settings" : `/settings/${view}`;

/** A visão aberta agora (`?settings=`), ou `undefined` com o modal fechado. */
export function useSettingsView(): SettingsView | undefined {
  return useRouterState({
    select: (s) => parseView((s.location.search as Record<string, unknown>).settings),
  });
}

type AppRouter = ReturnType<typeof useRouter>;

/** Navega para uma visão do modal (ou fecha, com `null`) mantendo a rota e os parâmetros atuais. */
export function goSettings(
  router: AppRouter,
  view: SettingsView | null,
  replace: boolean,
  dropKeys: readonly string[] = [],
  inApp = false,
) {
  return router.navigate({
    // `inApp` fica no state da entrada do histórico: o modal foi aberto de dentro do app (fechar = voltar uma entrada).
    state: (view && inApp ? { settingsInApp: true } : undefined) as never,
    to: router.state.location.pathname as never,
    search: ((prev: Record<string, unknown>) => {
      const next: Record<string, unknown> = { ...prev, settings: view ?? undefined };
      for (const k of dropKeys) delete next[k];
      return next;
    }) as never,
    mask: view ? ({ to: settingsHref(view), search: {} } as never) : undefined,
    replace,
  });
}

const openedInApp = (router: AppRouter) =>
  !!(router.state.location.state as unknown as Record<string, unknown>).settingsInApp;

/** Abre uma seção a partir de código que não tem o hook (ex.: menus que podem existir sem roteador nos testes). */
export function openSettingsIn(router: AppRouter, section: SectionKey) {
  saveLastSection(section);
  const already = parseView((router.state.location.search as Record<string, unknown>).settings);
  return goSettings(router, section, !!already, [], already ? openedInApp(router) : true);
}

/**
 * Abre, troca e fecha o modal de configurações. Abrir empilha uma entrada no histórico (Voltar do navegador
 * fecha o modal); trocar de seção substitui a entrada; fechar volta uma entrada se o modal foi aberto de dentro
 * do app, ou só tira o parâmetro quando veio de um link direto.
 */
export function useSettingsNav() {
  const router = useRouter();
  const compact = useMediaQuery(NAV_COMPACT_QUERY);

  const go = useCallback(
    (
      view: SettingsView | null,
      replace: boolean,
      dropKeys: readonly string[] = [],
      inApp = false,
    ) => goSettings(router, view, replace, dropKeys, inApp),
    [router],
  );

  /** Abre o modal. Sem argumento: a última seção vista (ou a lista, no celular). */
  const open = useCallback(
    (section?: SectionKey) => {
      const last = sectionOf(loadLastSection() ?? undefined)?.key;
      const view: SettingsView = section ?? (compact ? "menu" : (last ?? "profile"));
      if (section) saveLastSection(section);
      const already = parseView((router.state.location.search as Record<string, unknown>).settings);
      return go(view, !!already, [], already ? openedInApp(router) : true);
    },
    [compact, go, router],
  );

  /** Troca a visão sem empilhar histórico. */
  const show = useCallback(
    (view: SettingsView, dropKeys?: readonly string[]) => {
      if (view !== "menu") saveLastSection(view);
      return go(view, true, dropKeys, openedInApp(router));
    },
    [go, router],
  );

  const close = useCallback(() => {
    if (openedInApp(router)) {
      router.history.back();
      return;
    }
    return go(null, true);
  }, [go, router]);

  return { open, show, close };
}

/**
 * Link para uma seção das configurações: o `href` é o endereço público (`/settings/<seção>`, copiável e
 * abrível em nova aba), mas o clique simples abre o modal sobre a tela atual em vez de sair dela.
 */
export function SettingsLink({
  section,
  onClick,
  ...props
}: { section: SectionKey } & Omit<ComponentProps<"a">, "href">) {
  const { open } = useSettingsNav();
  return (
    <a
      {...props}
      href={settingsHref(section)}
      onClick={(e) => {
        onClick?.(e);
        if (
          e.defaultPrevented ||
          e.button !== 0 ||
          e.metaKey ||
          e.ctrlKey ||
          e.shiftKey ||
          e.altKey
        )
          return;
        e.preventDefault();
        void open(section);
      }}
    />
  );
}
