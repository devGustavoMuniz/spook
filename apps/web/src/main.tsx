import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { bootstrapDesktop } from "@/desktop/bootstrap";
import { setupServiceWorker } from "@/features/push/sw-client";
import { createQueryClient } from "@/lib/query";
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
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
          <Toaster />
        </QueryClientProvider>
      </ThemeProvider>
    </StrictMode>,
  );
}

// No Tauri, lê o token do chaveiro e instala a URL base, os cabeçalhos e a engine de voz antes do 1º render
// (o guard de rotas já chama a API). Na web não faz nada.
void bootstrapDesktop().then(start);
