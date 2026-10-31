import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { setupServiceWorker } from "@/features/push/sw-client";
import { createQueryClient } from "@/lib/query";
import { createAppRouter } from "@/router";
import "./styles.css";

const queryClient = createQueryClient();
const router = createAppRouter(queryClient);
setupServiceWorker((href) => void router.navigate({ href }));

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
