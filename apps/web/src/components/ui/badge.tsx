import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap [&_svg]:size-3",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground",
        brand: "bg-accent text-brand-text",
        secondary: "bg-secondary text-secondary-foreground",
        outline: "border-border text-foreground",
        success: "bg-success-soft text-success-text",
        warning: "bg-warning-soft text-warning-text",
        destructive: "bg-danger-soft text-destructive-text",
        info: "bg-info-soft text-info-text",
      },
    },
    defaultVariants: { variant: "secondary" },
  },
);

function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

/** Contador de não lidas/menções: "99+" acima de 99, números tabulares, vermelho para menção e roxo para o resto. */
function CountBadge({
  count,
  max = 99,
  tone = "mention",
  className,
  ...props
}: Omit<React.ComponentProps<"span">, "children"> & {
  count: number;
  max?: number;
  tone?: "mention" | "brand";
}) {
  if (count <= 0) return null;
  return (
    <span
      data-numeric
      className={cn(
        "inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-full px-1 text-[0.6875rem] leading-none font-semibold",
        tone === "mention"
          ? "bg-destructive text-destructive-foreground"
          : "bg-primary text-primary-foreground",
        className,
      )}
      {...props}
    >
      {count > max ? `${max}+` : count}
    </span>
  );
}

export { Badge, badgeVariants, CountBadge };
