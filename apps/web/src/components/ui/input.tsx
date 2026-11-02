import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/utils";

// Estados: hover (borda mais forte), foco (anel do CSS base + borda), inválido (aria-invalid), desativado (CSS base).
const fieldVariants = cva(
  "flex w-full min-w-0 rounded-md border border-input bg-field px-3 text-foreground shadow-xs transition-colors hover:border-brand-400 focus-visible:border-ring aria-invalid:border-destructive-text aria-invalid:focus-visible:outline-destructive-text read-only:bg-muted file:mr-3 file:border-0 file:bg-transparent file:text-sm file:font-medium",
  {
    variants: {
      size: {
        sm: "h-8 text-[0.8125rem]",
        default: "h-9 text-sm",
        lg: "h-11 text-base",
      },
    },
    defaultVariants: { size: "default" },
  },
);

function Input({
  className,
  type,
  size,
  ...props
}: Omit<React.ComponentProps<"input">, "size"> & VariantProps<typeof fieldVariants>) {
  return (
    <input type={type} className={cn(fieldVariants({ size }), "py-1", className)} {...props} />
  );
}

export { fieldVariants, Input };
