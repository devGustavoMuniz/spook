import type { ReactNode } from "react";
import { Lettering, Logo } from "@/components/brand";
import { ThemeToggle } from "@/components/theme-toggle";

// Tela de entrada (SPEC 9.1): mascote, lettering e as duas frases oficiais.
export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex min-h-svh flex-col items-center justify-center gap-6 px-4 py-10">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      <header className="flex flex-col items-center gap-3 text-center">
        <Logo size={96} />
        <Lettering height={36} />
        <p className="text-lg font-medium">Seus servidores, sua galera, num só lugar.</p>
        <p className="text-sm text-muted-foreground">Chat · Voz · Vídeo · Compartilhar tela</p>
      </header>
      <main className="w-full max-w-sm">{children}</main>
    </div>
  );
}
