import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";

export type Theme = "system" | "light" | "dark";
const STORAGE_KEY = "spook-theme";

type Ctx = { theme: Theme; resolved: "light" | "dark"; setTheme: (t: Theme) => void };
const ThemeContext = createContext<Ctx | null>(null);

function readStored(): Theme {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    // armazenamento indisponível (modo privado etc.): segue o sistema
  }
  return "system";
}

const systemDark = () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readStored);
  const [prefersDark, setPrefersDark] = useState(systemDark);

  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return;
    const on = () => setPrefersDark(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  const resolved = theme === "system" ? (prefersDark ? "dark" : "light") : theme;

  useEffect(() => {
    document.documentElement.classList.toggle("dark", resolved === "dark");
  }, [resolved]);

  const value = useMemo<Ctx>(
    () => ({
      theme,
      resolved,
      setTheme: (t) => {
        setThemeState(t);
        try {
          localStorage.setItem(STORAGE_KEY, t);
        } catch {
          // sem persistência: vale só nesta sessão
        }
      },
    }),
    [theme, resolved],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme precisa do ThemeProvider");
  return ctx;
}
