import { Link } from "@tanstack/react-router";
import { NotFoundIllustration } from "@/components/illustrations";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";

/** 404 reutilizável (deslogado e logado): ilustração, título, texto e volta ao início. */
export function NotFoundPage() {
  const { t } = useT();
  return (
    <div className="grid min-h-svh place-items-center bg-brand-glow px-4 py-10">
      <main className="flex w-full max-w-md flex-col items-center gap-3 rounded-xl border border-border bg-card px-6 py-8 text-center shadow-md">
        <NotFoundIllustration className="mb-1 h-40 w-auto" />
        <h1 className="text-2xl font-semibold tracking-tight text-balance">
          {t("shell.notFound.title")}
        </h1>
        <p className="max-w-sm text-sm text-muted-foreground text-pretty">
          {t("shell.notFound.body")}
        </p>
        <Button asChild size="lg" className="mt-2">
          <Link to="/">{t("shell.notFound.back")}</Link>
        </Button>
      </main>
    </div>
  );
}
