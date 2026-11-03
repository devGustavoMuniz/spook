import { Component, type ErrorInfo, type ReactNode } from "react";
import { ErrorIllustration } from "@/components/illustrations";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";

/** Tela de falha inesperada: sem stack para a pessoa; os detalhes vão para o console. */
export function CrashScreen({ onReset }: { onReset?: () => void }) {
  const { t } = useT();
  return (
    <div className="grid min-h-svh place-items-center bg-brand-glow px-4 py-10">
      <main
        role="alert"
        className="flex w-full max-w-md flex-col items-center gap-3 rounded-xl border border-border bg-card px-6 py-8 text-center shadow-md"
      >
        <ErrorIllustration className="mb-1 h-40 w-auto" />
        <h1 className="text-2xl font-semibold tracking-tight text-balance">
          {t("shell.crash.title")}
        </h1>
        <p className="max-w-sm text-sm text-muted-foreground text-pretty">
          {t("shell.crash.body")}
        </p>
        <div className="mt-2 flex flex-wrap justify-center gap-2">
          <Button size="lg" onClick={() => (onReset ? onReset() : window.location.reload())}>
            {t("shell.crash.reload")}
          </Button>
          <Button size="lg" variant="outline" asChild>
            <a href="/">{t("shell.crash.home")}</a>
          </Button>
        </div>
      </main>
    </div>
  );
}

/** ErrorBoundary global (React só captura erros de renderização em classes). */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Erro de renderização", error, info.componentStack);
  }

  render() {
    return this.state.failed ? (
      <CrashScreen onReset={() => window.location.reload()} />
    ) : (
      this.props.children
    );
  }
}
