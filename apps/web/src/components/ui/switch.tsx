import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/utils";

const trackVariants = cva(
  "peer inline-flex shrink-0 items-center rounded-full border-2 border-transparent bg-input transition-colors data-[state=checked]:bg-primary",
  {
    variants: {
      size: {
        default: "h-5 w-9 [&_span]:size-4 [&_span]:data-[state=checked]:translate-x-4",
        sm: "h-4 w-7 [&_span]:size-3 [&_span]:data-[state=checked]:translate-x-3",
      },
    },
    defaultVariants: { size: "default" },
  },
);

function Switch({
  className,
  size,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & VariantProps<typeof trackVariants>) {
  return (
    <SwitchPrimitive.Root className={cn(trackVariants({ size }), className)} {...props}>
      <SwitchPrimitive.Thumb className="pointer-events-none block translate-x-0 rounded-full bg-white shadow-sm transition-transform duration-[var(--dur-base)] ease-[var(--ease-spring)]" />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
