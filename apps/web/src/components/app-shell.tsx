import { getGetMeQueryKey, isApiError, useGetMe, useLogout } from "@spook/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import { LogOut } from "lucide-react";
import { useEffect } from "react";
import { toast } from "sonner";
import { Lettering } from "@/components/brand";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";

export function AppShell() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const me = useGetMe();
  const logout = useLogout();

  // Sessão expirou/foi revogada em outra aba: volta ao login.
  useEffect(() => {
    if (isApiError(me.error) && me.error.status === 401) {
      qc.clear();
      void navigate({ to: "/login" });
    }
  }, [me.error, qc, navigate]);

  async function signOut() {
    try {
      await logout.mutateAsync();
    } catch (e) {
      // 401 = a sessão já tinha caído; o resultado desejado (deslogado) é o mesmo.
      if (!isApiError(e) || e.status !== 401) {
        toast.error("Não foi possível sair. Tente novamente.");
        return;
      }
    }
    qc.removeQueries({ queryKey: getGetMeQueryKey() });
    qc.clear();
    await navigate({ to: "/login" });
  }

  return (
    <div className="min-h-svh">
      <header className="flex items-center justify-between border-b px-4 py-3">
        <Link to="/" aria-label="Início">
          <Lettering height={28} />
        </Link>
        <nav className="flex items-center gap-1" aria-label="Principal">
          <Button asChild variant="ghost" size="sm">
            <Link to="/settings/profile">Perfil</Link>
          </Button>
          <ThemeToggle />
          <Button variant="outline" size="sm" onClick={signOut} disabled={logout.isPending}>
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
