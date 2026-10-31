import { isApiError, useGetMe } from "@spook/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import { LogOut } from "lucide-react";
import { useEffect } from "react";
import { useSignOut } from "@/auth/use-sign-out";
import { Lettering } from "@/components/brand";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { isTauri } from "@/desktop/runtime";

/** Páginas "comuns" (perfil): cabeçalho com marca e menu, conteúdo central. */
export function PageShell() {
  const { signOut, pending } = useSignOut();
  return (
    <div className="h-full overflow-y-auto">
      <header className="flex items-center justify-between border-b px-4 py-3">
        <Link to="/" aria-label="Início">
          <Lettering height={28} />
        </Link>
        <nav className="flex items-center gap-1" aria-label="Principal">
          <Button asChild variant="ghost" size="sm">
            <Link to="/settings/profile">Perfil</Link>
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link to="/settings/notifications">Notificações</Link>
          </Button>
          {isTauri() ? (
            <Button asChild variant="ghost" size="sm">
              <Link to="/settings/app">Aplicativo</Link>
            </Button>
          ) : null}
          <ThemeToggle />
          <Button variant="outline" size="sm" onClick={signOut} disabled={pending}>
            <LogOut /> Sair
          </Button>
        </nav>
      </header>
      <main className="mx-auto w-full max-w-2xl px-4 py-8">
        <Outlet />
      </main>
    </div>
  );
}

/** Rail de servidores + área de conteúdo; observa a sessão (401 em outra aba volta ao login). */
export function useSessionGuard() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const me = useGetMe();
  useEffect(() => {
    if (isApiError(me.error) && me.error.status === 401) {
      qc.clear();
      void navigate({ to: "/login" });
    }
  }, [me.error, qc, navigate]);
}
