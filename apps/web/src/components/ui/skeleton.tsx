import type * as React from "react";
import { cn } from "@/lib/utils";

/** Bloco de carregamento: base suave com um brilho que desliza (só transform). Com movimento reduzido fica estático. */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "relative overflow-hidden rounded-md bg-muted before:absolute before:inset-0 before:-translate-x-full before:animate-shimmer before:bg-linear-to-r before:from-transparent before:via-foreground/6 before:to-transparent",
        className,
      )}
      {...props}
    />
  );
}

export { Skeleton };
