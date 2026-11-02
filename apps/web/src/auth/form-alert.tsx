import { AlertTriangle } from "lucide-react";

/** Erro geral do formulário (o do servidor, sem campo): bloco destacado com ícone. */
export function FormAlert({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2.5 rounded-md border border-destructive-text/40 bg-danger-soft p-3 text-sm text-destructive-text"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <p>{children}</p>
    </div>
  );
}
