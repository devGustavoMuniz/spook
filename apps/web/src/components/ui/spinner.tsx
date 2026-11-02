import { Loader2 } from "lucide-react";
import type * as React from "react";
import { cn } from "@/lib/utils";

/** Indicador de carregamento. Gira mesmo com movimento reduzido (comunica estado, não decora). */
function Spinner({ className, ...props }: React.ComponentProps<typeof Loader2>) {
  return (
    <Loader2
      aria-hidden="true"
      className={cn("motion-essential size-4 animate-spin", className)}
      {...props}
    />
  );
}

export { Spinner };
