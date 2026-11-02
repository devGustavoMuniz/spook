import letteringLight from "@spook/brand/assets/lettering-fundo-claro.svg";
import letteringDark from "@spook/brand/assets/lettering-fundo-escuro.svg";
import markLight from "@spook/brand/assets/mascote-fundo-claro.svg";
import markDark from "@spook/brand/assets/mascote-fundo-escuro.svg";
import { useTheme } from "@/components/theme-provider";
import { cn } from "@/lib/utils";

/**
 * Mascote da marca (SPEC 9.4) com fundo TRANSPARENTE: é o único ponto de entrada da logo na interface.
 * O asset (`mascote-fundo-*.svg`, derivado de `logo*.svg` sem as ondas laterais) tem viewBox quadrado e
 * centrado no corpo do fantasma, então cabe em qualquer círculo/tile sem deslocamento. Troca com o tema.
 * `glow` acrescenta o brilho neon (drop-shadow) das telas de entrada.
 */
export function LogoMark({
  size = 96,
  glow = false,
  alt = "Spook",
  className,
}: {
  size?: number;
  glow?: boolean;
  /** Use `""` quando o ícone for decorativo (o rótulo está no elemento em volta). */
  alt?: string;
  className?: string;
}) {
  const { resolved } = useTheme();
  return (
    <img
      src={resolved === "dark" ? markDark : markLight}
      alt={alt}
      width={size}
      height={size}
      draggable={false}
      className={cn(
        "block shrink-0 select-none",
        glow && "drop-shadow-[0_0_18px_color-mix(in_oklab,var(--brand-400)_70%,transparent)]",
        className,
      )}
    />
  );
}

/** Lettering "SPOOK" (vetor): a largura segue a proporção do asset (520,44 x 189,51). */
export function Lettering({ width = 220, className }: { width?: number; className?: string }) {
  const { resolved } = useTheme();
  return (
    <img
      src={resolved === "dark" ? letteringDark : letteringLight}
      alt="SPOOK"
      width={width}
      height={Math.round((width * 189.51) / 520.44)}
      draggable={false}
      className={cn("block h-auto max-w-full select-none", className)}
    />
  );
}
