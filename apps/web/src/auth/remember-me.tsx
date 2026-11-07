import type { ComponentProps } from "react";
import { useT } from "@/i18n";

/**
 * "Manter conectado" do login e do cadastro. Marcado por padrão (sessão longa); desmarcado, a sessão some ao
 * fechar o navegador. É um checkbox nativo: foco, teclado e leitores de tela vêm de graça.
 */
export function RememberMe({ id = "remember", ...props }: ComponentProps<"input">) {
  const { t } = useT();
  return (
    <div className="flex items-start gap-3">
      <input
        id={id}
        type="checkbox"
        className="mt-0.5 size-4 shrink-0 cursor-pointer accent-primary disabled:cursor-not-allowed"
        aria-describedby={`${id}-hint`}
        {...props}
      />
      <div className="flex flex-col text-sm">
        <label htmlFor={id} className="cursor-pointer font-medium">
          {t("auth.keepSignedIn")}
        </label>
        <span id={`${id}-hint`} className="text-xs text-muted-foreground">
          {t("auth.keepSignedInHint")}
        </span>
      </div>
    </div>
  );
}
