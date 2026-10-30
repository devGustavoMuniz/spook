import letteringLight from "@spook/brand/assets/lettering-fundo-claro.svg";
import letteringDark from "@spook/brand/assets/lettering-fundo-escuro.svg";
import logoDark from "@spook/brand/assets/logo.svg";
import logoLight from "@spook/brand/assets/logo-fundo-claro.svg";
import { useTheme } from "@/components/theme-provider";

// SPEC 9.4: a versão do arquivo troca conforme o tema (fundo escuro x claro).
export function Logo({ size = 96, className }: { size?: number; className?: string }) {
  const { resolved } = useTheme();
  return (
    <img
      src={resolved === "dark" ? logoDark : logoLight}
      alt="Spook"
      width={size}
      height={size}
      className={className}
    />
  );
}

export function Lettering({ height = 40, className }: { height?: number; className?: string }) {
  const { resolved } = useTheme();
  return (
    <img
      src={resolved === "dark" ? letteringDark : letteringLight}
      alt="SPOOK"
      height={height}
      style={{ height }}
      className={className}
    />
  );
}
