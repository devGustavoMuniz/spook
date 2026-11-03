import { type ReactNode, useEffect } from "react";
import { useLocale } from "./core";

/** Mantém `<html lang>` em dia com o idioma ativo; a troca em si vive em `setLocale` (store externo). */
export function I18nProvider({ children }: { children: ReactNode }) {
  const locale = useLocale();
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  return children;
}
