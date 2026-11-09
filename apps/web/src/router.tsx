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
import { parseView, type SettingsView } from "@/features/settings/sections";
import { settingsHref } from "@/features/settings/use-settings";
import { FriendsPage } from "@/features/social/friends-page";
import { queryKeys } from "@/lib/queryKeys";
import { authSearch, safeRedirect } from "@/lib/redirect";
import { AdminCallsPage } from "@/pages/admin/calls";
import { AdminDashboardPage } from "@/pages/admin/dashboard";
import { AdminNitroPage } from "@/pages/admin/nitro";
import { AdminServersPage } from "@/pages/admin/servers";
import { AdminTicketsPage } from "@/pages/admin/tickets";
import { AdminUsersPage } from "@/pages/admin/users";
import { ChooseUsernamePage } from "@/pages/choose-username";
import { DesktopLoginPage } from "@/pages/desktop-login";
import { DmIndex, DmLayout, DmPage } from "@/pages/dms";
import { DownloadPage } from "@/pages/download";
import { ForgotPasswordPage } from "@/pages/forgot-password";
import { ChannelPage, GuildIndex, GuildLayout } from "@/pages/guild";
import { HomePage } from "@/pages/home";
import { InvitePage } from "@/pages/invite";
import { LoginPage } from "@/pages/login";
import { RegisterPage } from "@/pages/register";
import { ResetPasswordPage } from "@/pages/reset-password";
import { VerifyEmailPage } from "@/pages/verify-email";

export type RouterContext = { queryClient: QueryClient };

const rootRoute = createRootRouteWithContext<RouterContext>()({
  // `?settings=` abre o modal de configurações sobre qualquer tela do app (veja `features/settings`).
  // `?payment=` é o retorno do Mercado Pago (Configurações > Nitro); precisa sobreviver ao redirecionamento de /settings/nitro.
  validateSearch: (
    s: Record<string, unknown>,
  ): { settings?: SettingsView; payment?: "success" | "failure" | "pending" } => {
    const settings = parseView(s.settings);
    const payment =
      s.payment === "success" || s.payment === "failure" || s.payment === "pending"
        ? s.payment
        : undefined;
    return { ...(settings ? { settings } : {}), ...(payment ? { payment } : {}) };
  },
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

// Recuperação de senha, verificação de e-mail e cadastro social: públicas (o link do e-mail pode abrir em outro
// navegador, sem sessão). O `token` é lido pela página e retirado da URL.
const tokenSearch = (s: Record<string, unknown>): { token?: string } =>
  typeof s.token === "string" || typeof s.token === "number" ? { token: String(s.token) } : {};
const forgotPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/forgot-password",
  component: ForgotPasswordPage,
});
const resetPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/reset-password",
  validateSearch: tokenSearch,
  component: ResetPasswordPage,
});
const verifyEmailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/verify-email",
  validateSearch: tokenSearch,
  component: VerifyEmailPage,
});
const chooseUsernameRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/auth/choose-username",
  validateSearch: authSearch,
  component: ChooseUsernamePage,
});
// Login do app desktop pelo navegador: precisa de sessão (volta aqui depois de entrar).
const desktopLoginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/desktop-login",
  validateSearch: (s: Record<string, unknown>): { code_challenge?: string } =>
    typeof s.code_challenge === "string" ? { code_challenge: s.code_challenge } : {},
  beforeLoad: async ({ context, location }) => {
    if (!(await fetchSession(context.queryClient)))
      throw redirect({ to: "/login", search: { redirect: safeRedirect(location.href) } });
  },
  component: DesktopLoginPage,
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
// Configurações são um MODAL sobre o app (`features/settings/settings-modal.tsx`), controlado pelo parâmetro
// `?settings=` da rota em que a pessoa está; a URL mostrada é `/settings/<seção>` (máscara). Estas rotas existem
// só para o endereço direto (link, recarga, retorno do OAuth): abrem o app (`/`) com o modal naquela seção,
// preservando os demais parâmetros (`linked`, `reauth`...).
const openSettingsFrom = (view: SettingsView) => (search: Record<string, unknown>) => {
  const { settings: _drop, ...rest } = search;
  throw redirect({
    to: "/",
    search: { ...rest, settings: view } as never,
    mask: { to: settingsHref(view), search: rest } as never,
    replace: true,
  });
};
const settingsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/settings",
  beforeLoad: ({ location }) => openSettingsFrom("menu")(location.search),
});
const settingsSectionRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/settings/$section",
  beforeLoad: ({ location, params }) =>
    openSettingsFrom(parseView(params.section) ?? "menu")(location.search),
});

// Endereço antigo do perfil.
const legacyProfileRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/profile",
  beforeLoad: () => {
    openSettingsFrom("profile")({});
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
// `/channels/@me/friends` (estático) tem prioridade sobre `$channelId`.
const friendsRoute = createRoute({
  getParentRoute: () => dmRoute,
  path: "friends",
  component: FriendsPage,
});
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
const adminTicketsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "tickets",
  component: AdminTicketsPage,
});
const adminNitroRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "nitro",
  component: AdminNitroPage,
});
const adminTicketRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "tickets/$ticketId",
  component: AdminTicketsPage,
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
  adminRoute.addChildren([
    adminIndexRoute,
    adminUsersRoute,
    adminServersRoute,
    adminCallsRoute,
    adminTicketsRoute,
    adminTicketRoute,
    adminNitroRoute,
  ]),
  loginRoute,
  registerRoute,
  forgotPasswordRoute,
  resetPasswordRoute,
  verifyEmailRoute,
  chooseUsernameRoute,
  desktopLoginRoute,
  downloadRoute,
  legacyProfileRoute,
  authedRoute.addChildren([
    homeRoute,
    settingsRoute,
    settingsSectionRoute,
    dmRoute.addChildren([dmIndexRoute, friendsRoute, dmChannelRoute]),
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
