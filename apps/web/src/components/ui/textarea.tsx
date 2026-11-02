import type * as React from "react";
import { cn } from "@/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      className={cn(
        "flex min-h-16 w-full resize-y rounded-md border border-input bg-field px-3 py-2 text-sm text-foreground shadow-xs transition-colors hover:border-brand-400 focus-visible:border-ring aria-invalid:border-destructive-text aria-invalid:focus-visible:outline-destructive-text read-only:bg-muted",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
