import { Link } from "@tanstack/react-router";
import { NotFoundIllustration } from "@/components/illustrations";
import { Button } from "@/components/ui/button";

/** 404 reutilizável (deslogado e logado): ilustração, título, texto e volta ao início. */
export function NotFoundPage() {
  return (
    <div className="grid min-h-svh place-items-center bg-brand-glow px-4 py-10">
      <main className="flex w-full max-w-md flex-col items-center gap-3 rounded-xl border border-border bg-card px-6 py-8 text-center shadow-md">
        <NotFoundIllustration className="mb-1 h-40 w-auto" />
        <h1 className="text-2xl font-semibold tracking-tight text-balance">
          Página não encontrada
        </h1>
        <p className="max-w-sm text-sm text-muted-foreground text-pretty">
          O endereço não existe ou foi movido. Confira o link ou volte para o início.
        </p>
        <Button asChild size="lg" className="mt-2">
          <Link to="/">Voltar ao início</Link>
        </Button>
      </main>
    </div>
  );
}
