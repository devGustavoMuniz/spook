import { useAdminTicketSummary, useGetMe } from "@spook/shared";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import {
  ArrowLeft,
  LayoutDashboard,
  LifeBuoy,
  LogOut,
  PanelLeft,
  Phone,
  Server,
  Sparkles,
  Users,
} from "lucide-react";
import { useState } from "react";
import { useSignOut } from "@/auth/use-sign-out";
import { useSessionGuard } from "@/components/app-shell";
import { LogoMark } from "@/components/brand";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/admin", label: "Dashboard", icon: LayoutDashboard, exact: true },
  { to: "/admin/users", label: "Usuários", icon: Users, exact: false },
  { to: "/admin/servers", label: "Servidores", icon: Server, exact: false },
  { to: "/admin/calls", label: "Chamadas", icon: Phone, exact: false },
  { to: "/admin/tickets", label: "Chamados", icon: LifeBuoy, exact: false },
  { to: "/admin/nitro", label: "Nitro", icon: Sparkles, exact: false },
] as const;

const wide = () => typeof window === "undefined" || window.innerWidth >= 768;

/** Layout do painel administrativo: barra lateral recolhível, cabeçalho com breadcrumb e a página. */
export function AdminLayout() {
  useSessionGuard();
  const { data: me } = useGetMe();
  const { signOut, pending } = useSignOut();
  const [open, setOpen] = useState(wide);
  // Chamados que esperam uma resposta da equipe (abertos): selo ao lado do item do menu.
  const { data: tickets } = useAdminTicketSummary({
    query: { refetchInterval: 30_000, staleTime: 10_000 },
  });
  const path = useRouterState({ select: (s) => s.location.pathname });
  const current = NAV.find((n) => (n.exact ? path === n.to : path.startsWith(n.to))) ?? NAV[0];
  return (
    <div className="relative flex h-svh overflow-hidden bg-background text-foreground">
      {open ? (
        <button
          type="button"
          aria-label="Fechar a barra lateral"
          className="fixed inset-0 z-[var(--z-overlay)] bg-overlay md:hidden"
          onClick={() => setOpen(false)}
        />
      ) : null}
      <aside
        id="admin-sidebar"
        aria-label="Painel de administração"
        inert={!open}
        className={cn(
          "z-[var(--z-modal)] flex w-64 shrink-0 flex-col border-r border-border bg-sidebar",
          "max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:shadow-xl max-md:transition-transform max-md:duration-[var(--dur-slow)] max-md:ease-[var(--ease-out)]",
          open ? "" : "max-md:-translate-x-full max-md:shadow-none md:hidden",
        )}
      >
        <div className="flex h-14 items-center gap-2.5 border-b border-border px-4">
          <LogoMark size={28} />
          <div className="leading-tight">
            <p className="font-semibold">Spook</p>
            <p className="text-xs text-muted-foreground">Painel de administração</p>
          </div>
        </div>
        <nav aria-label="Administração" className="flex-1 overflow-y-auto p-3">
          <p className="px-2 pb-1.5 text-xs font-medium text-muted-foreground">Administração</p>
          <ul className="flex flex-col gap-0.5">
            {NAV.map((n) => (
              <li key={n.to}>
                <Link
                  to={n.to}
                  activeOptions={{ exact: n.exact }}
                  onClick={() => !wide() && setOpen(false)}
                  className="flex min-h-10 items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-[status=active]:bg-brand-500/15 data-[status=active]:font-medium data-[status=active]:text-foreground data-[status=active]:shadow-[inset_2px_0_0_var(--primary)]"
                >
                  <n.icon className="size-4" aria-hidden /> {n.label}
                  {n.to === "/admin/tickets" && tickets && tickets.open > 0 ? (
                    <span className="tabular ml-auto rounded-full bg-primary px-1.5 py-0.5 text-xs font-medium text-primary-foreground">
                      <span aria-hidden>{tickets.open > 99 ? "99+" : tickets.open}</span>
                      <span className="sr-only">{`${tickets.open} chamados abertos`}</span>
                    </span>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="flex flex-col gap-1 border-t border-border p-3">
          <Link
            to="/"
            className="flex min-h-10 items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ArrowLeft className="size-4" aria-hidden /> Voltar ao app
          </Link>
          <div className="flex items-center justify-between gap-1 px-2.5 pt-1">
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
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface-1 px-4">
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
        <main className="relative min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
          <div className="mx-auto w-full max-w-7xl">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
