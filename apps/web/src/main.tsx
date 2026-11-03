import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "@/components/error-boundary";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { bootstrapDesktop } from "@/desktop/bootstrap";
import { DesktopShell } from "@/desktop/desktop-shell";
import { ScreenSourceDialog } from "@/desktop/screen-source-dialog";
import { UpdateSplash } from "@/desktop/update-splash";
import { UpdateWatcher } from "@/desktop/update-watcher";
import { setupServiceWorker } from "@/features/push/sw-client";
import { I18nProvider } from "@/i18n";
import { createQueryClient } from "@/lib/query";
import { VersionWatcher } from "@/lib/version-watcher";
import { createAppRouter } from "@/router";
import "./styles.css";

function start(desktop: boolean) {
  const queryClient = createQueryClient();
  const router = createAppRouter(queryClient);
  // Sem service worker no desktop: lá as notificações são as nativas do sistema.
  if (!desktop) setupServiceWorker((href) => void router.navigate({ href }));

  // biome-ignore lint/style/noNonNullAssertion: o elemento existe no index.html
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <I18nProvider>
        <ThemeProvider>
          <ErrorBoundary>
            <QueryClientProvider client={queryClient}>
              <RouterProvider router={router} />
              <Toaster />
              {desktop ? <ScreenSourceDialog /> : null}
              {desktop ? (
                <DesktopShell navigate={(href) => void router.navigate({ href })} />
              ) : null}
              {desktop ? <UpdateWatcher /> : null}
              {desktop ? <UpdateSplash /> : null}
              <VersionWatcher />
            </QueryClientProvider>
          </ErrorBoundary>
        </ThemeProvider>
      </I18nProvider>
    </StrictMode>,
  );
}

// No Tauri, lê o token do chaveiro e instala a URL base, os cabeçalhos e a engine de voz antes do 1º render
// (o guard de rotas já chama a API). Na web não faz nada.
void bootstrapDesktop().then(start);
