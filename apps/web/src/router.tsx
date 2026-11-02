import { listGuilds } from "@spook/shared";
import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { fetchSession } from "@/auth/session";
import { AuthedLayout } from "@/components/authed-layout";
import { CrashScreen } from "@/components/error-boundary";
import { NotFoundPage } from "@/components/not-found";
import { AdminLayout } from "@/features/admin/admin-layout";
import { SettingsLayout } from "@/features/settings/settings-layout";
import { queryKeys } from "@/lib/queryKeys";
import { authSearch, safeRedirect } from "@/lib/redirect";
import { AdminCallsPage } from "@/pages/admin/calls";
import { AdminDashboardPage } from "@/pages/admin/dashboard";
import { AdminServersPage } from "@/pages/admin/servers";
import { AdminUsersPage } from "@/pages/admin/users";
import { AppSettingsPage } from "@/pages/app-settings";
import { DmIndex, DmLayout, DmPage } from "@/pages/dms";
import { DownloadPage } from "@/pages/download";
import { ChannelPage, GuildIndex, GuildLayout } from "@/pages/guild";
import { HomePage } from "@/pages/home";
import { InvitePage } from "@/pages/invite";
import { LoginPage } from "@/pages/login";
import { NotificationsPage } from "@/pages/notifications";
import { ProfilePage } from "@/pages/profile";
import { RegisterPage } from "@/pages/register";
import { AppearancePage } from "@/pages/settings-appearance";
import { VoiceSettingsPage } from "@/pages/settings-voice";

export type RouterContext = { queryClient: QueryClient };

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
  notFoundComponent: NotFoundPage,
  errorComponent: () => <CrashScreen />,
});

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

// Pública e fora do layout autenticado: quem ainda não tem conta (ou está logado) baixa o app por aqui.
const downloadRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/download",
  component: DownloadPage,
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

const homeRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/",
  component: HomePage,
});
// Configurações em tela cheia (layout próprio, sem a barra de servidores). `/settings` é a lista no celular
// e vai para o perfil no desktop (o layout decide); as seções são rotas irmãs para deep link.
const settingsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/settings",
  component: SettingsLayout,
});
const settingsIndexRoute = createRoute({ getParentRoute: () => settingsRoute, path: "/" });
const profileRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "profile",
  component: ProfilePage,
});
const notificationsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "notifications",
  component: NotificationsPage,
});
const voiceSettingsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "voice",
  component: VoiceSettingsPage,
});
const appearanceRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "appearance",
  component: AppearancePage,
});
// Só tem efeito no desktop (bandeja, início com o sistema); na web a seção some da navegação e a rota apenas explica.
const appSettingsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "app",
  component: AppSettingsPage,
});

// Endereço antigo do perfil.
const legacyProfileRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/profile",
  beforeLoad: () => {
    throw redirect({ to: "/settings/profile", replace: true });
  },
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

// Referência dos componentes (docs/design/DESIGN-SYSTEM.md): só existe em desenvolvimento, o build de produção não a inclui.
const devRoutes = import.meta.env.DEV
  ? [
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/dev/design-system",
        component: lazyRouteComponent(() =>
          import("@/pages/dev/design-system").then((m) => ({ default: m.DesignSystemPage })),
        ),
      }),
    ]
  : [];

const routeTree = rootRoute.addChildren([
  ...devRoutes,
  adminRoute.addChildren([adminIndexRoute, adminUsersRoute, adminServersRoute, adminCallsRoute]),
  loginRoute,
  registerRoute,
  downloadRoute,
  legacyProfileRoute,
  authedRoute.addChildren([
    homeRoute,
    settingsRoute.addChildren([
      settingsIndexRoute,
      profileRoute,
      notificationsRoute,
      voiceSettingsRoute,
      appearanceRoute,
      appSettingsRoute,
    ]),
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
