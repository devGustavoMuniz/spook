import type { CSSProperties } from "react";
import { Toaster as Sonner } from "sonner";
import { useTheme } from "@/components/theme-provider";

/** Toasts no estilo do app: superfície elevada, borda, raio e cores semânticas (sonner lê as variáveis `--normal-*`). */
export function Toaster() {
  const { resolved } = useTheme();
  return (
    <Sonner
      theme={resolved}
      position="top-center"
      richColors
      closeButton
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--success-bg": "var(--success-soft)",
          "--success-text": "var(--success-text)",
          "--success-border": "var(--success-text)",
          "--error-bg": "var(--danger-soft)",
          "--error-text": "var(--destructive-text)",
          "--error-border": "var(--destructive-text)",
          "--warning-bg": "var(--warning-soft)",
          "--warning-text": "var(--warning-text)",
          "--warning-border": "var(--warning-text)",
          "--info-bg": "var(--info-soft)",
          "--info-text": "var(--info-text)",
          "--info-border": "var(--info-text)",
          "--border-radius": "var(--radius-lg)",
          zIndex: "var(--z-toast)",
        } as CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "!shadow-lg !font-sans",
          title: "!font-medium",
        },
      }}
    />
  );
}
