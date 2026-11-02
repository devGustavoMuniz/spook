import { isApiError } from "@spook/shared";
import { Link } from "@tanstack/react-router";
import { Home, RotateCw } from "lucide-react";
import type { ReactNode } from "react";
import { ErrorIllustration, NotFoundIllustration } from "@/components/illustrations";
import { NavToggle } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { appMessage } from "@/lib/app-errors";
import { cn } from "@/lib/utils";

/**
 * Tela de estado dentro da área do app (servidor/canal/conversa inexistente, sem permissão, erro):
 * ilustração, título, texto e ações. Leva o `NavToggle` (< 768 px) como as demais telas sem cabeçalho.
 */
export function StateScreen({
  title,
  description,
  illustration = <NotFoundIllustration className="h-40 w-auto" />,
  actions,
  className,
  role,
}: {
  title: string;
  description?: ReactNode;
  illustration?: ReactNode;
  actions?: ReactNode;
  className?: string;
  role?: "alert" | "status";
}) {
  return (
    <main
      className={cn("relative flex h-full min-h-0 flex-1 flex-col bg-brand-wash", className)}
      aria-labelledby="state-title"
    >
      <NavToggle className="absolute top-2 left-4" />
      <EmptyState
        role={role}
        illustration={illustration}
        title={<span id="state-title">{title}</span>}
        description={description}
        action={actions}
        className="gap-2 [&_h2]:text-xl [&_p]:max-w-md"
      />
    </main>
  );
}

export const HomeButton = ({ variant = "default" }: { variant?: "default" | "outline" }) => (
  <Button asChild variant={variant}>
    <Link to="/">
      <Home /> Ir para o início
    </Link>
  </Button>
);

/** Erro de carregamento: 403 vira "sem permissão"; rede e 5xx oferecem "Tentar de novo". */
export function ErrorState({
  error,
  onRetry,
  retrying,
}: {
  error: unknown;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const forbidden = isApiError(error) && error.status === 403;
  return (
    <StateScreen
      role="alert"
      illustration={<ErrorIllustration className="h-40 w-auto" />}
      title={forbidden ? "Sem permissão" : "Não foi possível carregar"}
      description={forbidden ? "Você não tem acesso a esta área." : appMessage(error)}
      actions={
        <>
          {!forbidden && onRetry ? (
            <Button onClick={onRetry} loading={retrying}>
              <RotateCw /> Tentar de novo
            </Button>
          ) : null}
          <HomeButton variant={forbidden || !onRetry ? "default" : "outline"} />
        </>
      }
    />
  );
}

/** Tela de estado de página inteira (fora do shell): cartão central sobre o brilho da marca, como o 404. */
export function StatePage({
  title,
  description,
  illustration = <NotFoundIllustration className="mb-1 h-40 w-auto" />,
  actions,
  alert,
}: {
  title: string;
  description?: ReactNode;
  illustration?: ReactNode;
  actions?: ReactNode;
  /** A descrição é anunciada como alerta (erros). */
  alert?: boolean;
}) {
  return (
    <div className="grid min-h-svh place-items-center bg-brand-glow px-4 py-10">
      <main className="flex w-full max-w-md flex-col items-center gap-3 rounded-xl border border-border bg-card px-6 py-8 text-center shadow-md">
        {illustration}
        <h1 className="text-2xl font-semibold tracking-tight text-balance">{title}</h1>
        {description ? (
          <p
            role={alert ? "alert" : undefined}
            className="max-w-sm text-sm text-muted-foreground text-pretty"
          >
            {description}
          </p>
        ) : null}
        {actions ? (
          <div className="mt-2 flex flex-wrap items-center justify-center gap-2">{actions}</div>
        ) : null}
      </main>
    </div>
  );
}
