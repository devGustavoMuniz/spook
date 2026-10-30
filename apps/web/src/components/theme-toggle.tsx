import { Monitor, Moon, Sun } from "lucide-react";
import { type Theme, useTheme } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";

const order: Theme[] = ["system", "light", "dark"];
const label: Record<Theme, string> = {
  system: "Tema do sistema",
  light: "Tema claro",
  dark: "Tema escuro",
};
const icon = { system: Monitor, light: Sun, dark: Moon };

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const next = order[(order.indexOf(theme) + 1) % order.length] as Theme;
  const Icon = icon[theme];
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => setTheme(next)}
      aria-label={`${label[theme]}. Alternar para ${label[next].toLowerCase()}`}
      title={label[theme]}
    >
      <Icon />
    </Button>
  );
}
