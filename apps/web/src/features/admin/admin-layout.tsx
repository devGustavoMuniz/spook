import { useGetMe } from "@spook/shared";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import {
  ArrowLeft,
  LayoutDashboard,
  LogOut,
  PanelLeft,
  Phone,
  Server,
  ShieldCheck,
  Users,
} from "lucide-react";
import { useState } from "react";
import { useSignOut } from "@/auth/use-sign-out";
import { useSessionGuard } from "@/components/app-shell";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/admin", label: "Dashboard", icon: LayoutDashboard, exact: true },
  { to: "/admin/users", label: "Usuários", icon: Users, exact: false },
  { to: "/admin/servers", label: "Servidores", icon: Server, exact: false },
  { to: "/admin/calls", label: "Chamadas", icon: Phone, exact: false },
] as const;

const wide = () => typeof window === "undefined" || window.innerWidth >= 768;

/** Layout do painel administrativo: barra lateral recolhível, cabeçalho com breadcrumb e a página. */
export function AdminLayout() {
  useSessionGuard();
  const { data: me } = useGetMe();
  const { signOut, pending } = useSignOut();
  const [open, setOpen] = useState(wide);
  const path = useRouterState({ select: (s) => s.location.pathname });
  const current = NAV.find((n) => (n.exact ? path === n.to : path.startsWith(n.to))) ?? NAV[0];
  return (
    <div className="flex h-svh bg-background text-foreground">
      {open ? (
        <button
          type="button"
          aria-label="Fechar a barra lateral"
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
          onClick={() => setOpen(false)}
        />
      ) : null}
      <aside
        id="admin-sidebar"
        aria-label="Painel de administração"
        className={cn(
          "z-40 flex w-60 shrink-0 flex-col border-r bg-sidebar",
          "max-md:fixed max-md:inset-y-0 max-md:left-0",
          open ? "" : "hidden",
        )}
      >
        <div className="flex items-center gap-2 border-b px-4 py-4">
          <ShieldCheck className="size-6 text-primary" aria-hidden />
          <div className="leading-tight">
            <p className="font-semibold">Spook</p>
            <p className="text-xs text-muted-foreground">Painel de administração</p>
          </div>
        </div>
        <nav aria-label="Administração" className="flex-1 overflow-y-auto p-3">
          <p className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Administração
          </p>
          <ul className="flex flex-col gap-1">
            {NAV.map((n) => (
              <li key={n.to}>
                <Link
                  to={n.to}
                  activeOptions={{ exact: n.exact }}
                  onClick={() => !wide() && setOpen(false)}
                  className="flex items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-accent data-[status=active]:bg-accent data-[status=active]:font-medium"
                >
                  <n.icon className="size-4" aria-hidden /> {n.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="flex flex-col gap-1 border-t p-3">
          <Link
            to="/"
            className="flex items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-accent"
          >
            <ArrowLeft className="size-4" aria-hidden /> Voltar ao app
          </Link>
          <div className="flex items-center justify-between gap-1 px-2 pt-1">
            <span className="min-w-0 truncate text-xs text-muted-foreground" title={me?.email}>
              @{me?.username ?? "…"}
            </span>
            <div className="flex">
              <ThemeToggle />
              <Button
                variant="ghost"
                size="icon"
                aria-label="Sair"
                onClick={signOut}
                disabled={pending}
              >
                <LogOut />
              </Button>
            </div>
          </div>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b px-4 py-3">
          <Button
            variant="ghost"
            size="icon"
            aria-label={open ? "Recolher a barra lateral" : "Abrir a barra lateral"}
            aria-expanded={open}
            aria-controls="admin-sidebar"
            onClick={() => setOpen((v) => !v)}
          >
            <PanelLeft />
          </Button>
          <nav aria-label="Você está em" className="text-sm text-muted-foreground">
            <ol className="flex items-center gap-1.5">
              <li>Administração</li>
              <li aria-hidden>/</li>
              <li aria-current="page" className="font-medium text-foreground">
                {current.label}
              </li>
            </ol>
          </nav>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
          <div className="mx-auto w-full max-w-7xl">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
