import miniLogo from "@spook/brand/assets/mini-logo.svg";
import { cn } from "@/lib/utils";

/** Avatar do usuário; sem imagem, usa a mini logo (SPEC 9.4). */
export function Avatar({
  url,
  name,
  size = 64,
  className,
}: {
  url?: string;
  name: string;
  size?: number;
  className?: string;
}) {
  return (
    <img
      src={url || miniLogo}
      alt={`Avatar de ${name}`}
      width={size}
      height={size}
      style={{ width: size, height: size }}
      className={cn("rounded-full bg-muted object-cover", className)}
    />
  );
}
