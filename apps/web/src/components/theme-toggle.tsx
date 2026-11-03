import { Monitor, Moon, Sun } from "lucide-react";
import { type Theme, useTheme } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { type MessageKey, useT } from "@/i18n";

const order: Theme[] = ["system", "light", "dark"];
const labelKey = {
  system: "shell.theme.system",
  light: "shell.theme.light",
  dark: "shell.theme.dark",
} as const satisfies Record<Theme, MessageKey>;
const icon = { system: Monitor, light: Sun, dark: Moon };

export function ThemeToggle({ variant = "outline" }: { variant?: "outline" | "ghost" }) {
  const { t } = useT();
  const { theme, setTheme } = useTheme();
  const next = order[(order.indexOf(theme) + 1) % order.length] as Theme;
  const Icon = icon[theme];
  const current = t(labelKey[theme]);
  const nextLabel = t(labelKey[next]).toLowerCase();
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={variant}
            size="icon"
            onClick={() => setTheme(next)}
            aria-label={t("shell.theme.toggleAria", { current, next: nextLabel })}
          >
            <Icon />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t("shell.theme.toggleTip", { current, next: nextLabel })}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
