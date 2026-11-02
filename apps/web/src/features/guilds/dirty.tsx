import { createContext, useContext, useEffect } from "react";

/** Quem tem alterações não salvas avisa o diálogo, que pergunta antes de fechar (Esc, fora, "x"). */
export const DirtyContext = createContext<(key: string, dirty: boolean) => void>(() => {});

export function useReportDirty(key: string, dirty: boolean) {
  const report = useContext(DirtyContext);
  useEffect(() => {
    report(key, dirty);
    return () => report(key, false);
  }, [key, dirty, report]);
}
