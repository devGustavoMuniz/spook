import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { createQueryClient } from "@/lib/query";
import { createAppRouter } from "@/router";
import { type Backend, makeBackend, server } from "@/test/server";

export async function renderApp(
  path: string,
  backend: { signedIn?: boolean; seed?: (state: Backend["state"]) => void } = {},
) {
  const fake = makeBackend(backend);
  backend.seed?.(fake.state);
  server.use(...fake.handlers);
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false, staleTime: 0 } });
  const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: [path] }));
  await router.load();
  const view = render(
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
        <Toaster />
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return { ...fake, router, unmount: view.unmount };
}
