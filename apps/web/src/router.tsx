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
import { AdminLayout } from "@/features/admin/admin-layout";
import { queryKeys } from "@/lib/queryKeys";
import { authSearch, safeRedirect } from "@/lib/redirect";
import { AdminCallsPage } from "@/pages/admin/calls";
import { AdminDashboardPage } from "@/pages/admin/dashboard";
import { AdminServersPage } from "@/pages/admin/servers";
import { AdminUsersPage } from "@/pages/admin/users";
import { AppSettingsPage } from "@/pages/app-settings";
import { DmIndex, DmLayout, DmPage } from "@/pages/dms";
import { ChannelPage, GuildIndex, GuildLayout } from "@/pages/guild";
import { HomePage } from "@/pages/home";
import { InvitePage } from "@/pages/invite";
import { LoginPage } from "@/pages/login";
import { NotificationsPage } from "@/pages/notifications";
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

const notificationsRoute = createRoute({
  getParentRoute: () => pageRoute,
  path: "/settings/notifications",
  component: NotificationsPage,
});

// Só tem efeito no desktop (bandeja, início com o sistema); na web a página apenas explica.
const appSettingsRoute = createRoute({
  getParentRoute: () => pageRoute,
  path: "/settings/app",
  component: AppSettingsPage,
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

// DMs: `/channels/@me` (estático) tem prioridade sobre `/channels/$guildId`.
const dmRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/channels/@me",
  component: DmLayout,
});
const dmIndexRoute = createRoute({ getParentRoute: () => dmRoute, path: "/", component: DmIndex });
const dmChannelRoute = createRoute({
  getParentRoute: () => dmRoute,
  path: "$channelId",
  component: DmPage,
});

const inviteRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/invite/$code",
  component: InvitePage,
});

// Painel administrativo: layout próprio (sem a barra de servidores). A checagem de verdade é no backend
// (/api/admin/** responde 403); aqui o guard só evita mostrar uma tela que daria erro a quem não é admin.
const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin",
  beforeLoad: async ({ context, location }) => {
    const me = await fetchSession(context.queryClient);
    if (!me) throw redirect({ to: "/login", search: { redirect: safeRedirect(location.href) } });
    if (!me.is_admin) throw redirect({ to: "/" });
  },
  component: AdminLayout,
});
const adminIndexRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/",
  component: AdminDashboardPage,
});
const adminUsersRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "users",
  component: AdminUsersPage,
});
const adminServersRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "servers",
  component: AdminServersPage,
});
const adminCallsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "calls",
  component: AdminCallsPage,
});

const routeTree = rootRoute.addChildren([
  adminRoute.addChildren([adminIndexRoute, adminUsersRoute, adminServersRoute, adminCallsRoute]),
  loginRoute,
  registerRoute,
  authedRoute.addChildren([
    homeRoute,
    pageRoute.addChildren([profileRoute, notificationsRoute, appSettingsRoute]),
    dmRoute.addChildren([dmIndexRoute, dmChannelRoute]),
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
