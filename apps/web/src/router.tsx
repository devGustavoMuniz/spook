import { listGuilds } from "@spook/shared";
import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { fetchSession } from "@/auth/session";
import { PageShell } from "@/components/app-shell";
import { AuthedLayout } from "@/components/authed-layout";
import { queryKeys } from "@/lib/queryKeys";
import { authSearch, safeRedirect } from "@/lib/redirect";
import { ChannelPage, GuildIndex, GuildLayout } from "@/pages/guild";
import { HomePage } from "@/pages/home";
import { InvitePage } from "@/pages/invite";
import { LoginPage } from "@/pages/login";
import { ProfilePage } from "@/pages/profile";
import { RegisterPage } from "@/pages/register";

export type RouterContext = { queryClient: QueryClient };

const rootRoute = createRootRouteWithContext<RouterContext>()({ component: Outlet });

// Públicas: quem já tem sessão vai direto para o início.
const redirectIfSignedIn = async ({
  context,
  search,
}: {
  context: RouterContext;
  search: { redirect?: string };
}) => {
  if (!(await fetchSession(context.queryClient))) return;
  if (search.redirect) throw redirect({ href: search.redirect });
  throw redirect({ to: "/" });
};

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: authSearch,
  beforeLoad: redirectIfSignedIn,
  component: LoginPage,
});

const registerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/register",
  validateSearch: authSearch,
  beforeLoad: redirectIfSignedIn,
  component: RegisterPage,
});

// Protegidas: sem sessão (401) => /login.
const authedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "authed",
  beforeLoad: async ({ context, location }) => {
    if (!(await fetchSession(context.queryClient)))
      throw redirect({ to: "/login", search: { redirect: safeRedirect(location.href) } });
  },
  // A lista de servidores (com canais e permissões) já vem carregada para as telas filhas.
  loader: ({ context }) =>
    context.queryClient
      .ensureQueryData({
        queryKey: queryKeys.guilds(),
        queryFn: ({ signal }) => listGuilds({ signal }),
      })
      .catch(() => null),
  component: AuthedLayout,
});

// Páginas comuns (perfil) dentro da área autenticada.
const pageRoute = createRoute({
  getParentRoute: () => authedRoute,
  id: "page",
  component: PageShell,
});

const homeRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/",
  component: HomePage,
});
const profileRoute = createRoute({
  getParentRoute: () => pageRoute,
  path: "/settings/profile",
  component: ProfilePage,
});

const guildRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/channels/$guildId",
  component: GuildLayout,
});
const guildIndexRoute = createRoute({
  getParentRoute: () => guildRoute,
  path: "/",
  component: GuildIndex,
});
const channelRoute = createRoute({
  getParentRoute: () => guildRoute,
  path: "$channelId",
  // `?perf=N` só vale em desenvolvimento: injeta N mensagens falsas para medir a lista (Fase B).
  validateSearch: (s: Record<string, unknown>): { perf?: number } => {
    const n = Number(s.perf);
    return import.meta.env.DEV && Number.isInteger(n) && n > 0 && n <= 200_000 ? { perf: n } : {};
  },
  component: ChannelPage,
});

const inviteRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/invite/$code",
  component: InvitePage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  registerRoute,
  authedRoute.addChildren([
    homeRoute,
    pageRoute.addChildren([profileRoute]),
    guildRoute.addChildren([guildIndexRoute, channelRoute]),
    inviteRoute,
  ]),
]);

export function createAppRouter(
  queryClient: QueryClient,
  history?: Parameters<typeof createRouter>[0]["history"],
) {
  return createRouter({ routeTree, context: { queryClient }, history, defaultPreload: "intent" });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
