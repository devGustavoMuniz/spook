import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { fetchSession } from "@/auth/session";
import { AppShell } from "@/components/app-shell";
import { HomePage } from "@/pages/home";
import { LoginPage } from "@/pages/login";
import { ProfilePage } from "@/pages/profile";
import { RegisterPage } from "@/pages/register";

export type RouterContext = { queryClient: QueryClient };

const rootRoute = createRootRouteWithContext<RouterContext>()({ component: Outlet });

// Públicas: quem já tem sessão vai direto para o início.
const redirectIfSignedIn = async ({ context }: { context: RouterContext }) => {
  if (await fetchSession(context.queryClient)) throw redirect({ to: "/" });
};

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  beforeLoad: redirectIfSignedIn,
  component: LoginPage,
});

const registerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/register",
  beforeLoad: redirectIfSignedIn,
  component: RegisterPage,
});

// Protegidas: sem sessão (401) => /login.
const authedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "authed",
  beforeLoad: async ({ context }) => {
    if (!(await fetchSession(context.queryClient))) throw redirect({ to: "/login" });
  },
  component: AppShell,
});

const homeRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/",
  component: HomePage,
});
const profileRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/settings/profile",
  component: ProfilePage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  registerRoute,
  authedRoute.addChildren([homeRoute, profileRoute]),
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
