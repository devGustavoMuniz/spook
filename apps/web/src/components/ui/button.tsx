import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

// Cursor, foco, `:active` e desativado vêm do CSS base (styles.css): aqui só cor, tamanho e forma.
const buttonVariants = cva(
  "relative inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap select-none [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-xs hover:bg-brand-600 hover:shadow-sm active:bg-brand-700 dark:hover:shadow-glow",
        destructive:
          "bg-destructive text-destructive-foreground shadow-xs hover:bg-destructive/90 active:bg-destructive/80",
        outline:
          "border border-border bg-card text-foreground shadow-xs hover:border-brand-400 hover:bg-accent active:bg-accent/70",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/70 active:bg-secondary/55",
        soft: "bg-accent text-brand-text hover:bg-accent/70 active:bg-accent/55",
        ghost: "text-foreground hover:bg-accent active:bg-accent/70",
        link: "h-auto rounded-xs p-0 text-brand-text underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4",
        sm: "h-8 px-3 text-[0.8125rem]",
        lg: "h-10 px-5",
        xl: "h-12 px-6 text-base",
        icon: "size-9",
        "icon-sm": "size-8",
        "icon-lg": "size-11",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

type ButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
    /** Mostra o spinner no lugar do conteúdo visível e bloqueia o clique (`aria-busy`). Ignorado com `asChild`. */
    loading?: boolean;
  };

function Button({
  className,
  variant,
  size,
  asChild = false,
  loading = false,
  disabled,
  children,
  ...props
}: ButtonProps) {
  const classes = cn(buttonVariants({ variant, size }), className);
  if (asChild) {
    return (
      <Slot className={classes} {...props}>
        {children}
      </Slot>
    );
  }
  return (
    <button
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? (
        <>
          <span className="invisible contents">{children}</span>
          <Spinner className="absolute" />
        </>
      ) : (
        children
      )}
    </button>
  );
}

export { Button, buttonVariants };
