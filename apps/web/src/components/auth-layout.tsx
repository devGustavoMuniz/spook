import type { ReactNode } from "react";
import { BrandHero } from "@/components/brand-hero";
import { ThemeToggle } from "@/components/theme-toggle";

/**
 * Tela de entrada (SPEC 9.1): em telas largas, marca à esquerda e formulário à direita;
 * em estreitas, uma coluna. O `h1` é o título do cartão (cada página define o seu).
 */
export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="relative isolate min-h-svh overflow-hidden bg-brand-glow">
      <div className="absolute top-3 right-4 z-[var(--z-sticky)] sm:top-4 sm:right-6">
        <ThemeToggle />
      </div>
      <div className="mx-auto grid min-h-svh w-full max-w-6xl items-center gap-8 px-4 py-16 sm:px-6 lg:grid-cols-[1fr_28rem] lg:gap-16 lg:py-10">
        <BrandHero />
        <main className="mx-auto w-full max-w-md">{children}</main>
      </div>
    </div>
  );
}
