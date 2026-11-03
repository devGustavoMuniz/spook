import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/utils";

const Tabs = TabsPrimitive.Root;

// `pill`: segmentado (padrão, como antes). `underline`: barra com sublinhado, para telas com muitas abas.
const listVariants = cva("inline-flex items-center", {
  variants: {
    variant: {
      pill: "w-fit gap-1 rounded-lg bg-muted p-1",
      underline: "w-full gap-1 border-b border-border",
    },
  },
  defaultVariants: { variant: "pill" },
});

const triggerVariants = cva(
  "inline-flex items-center justify-center gap-1.5 text-sm font-medium whitespace-nowrap text-muted-foreground hover:text-foreground data-[state=active]:text-foreground [&_svg]:size-4",
  {
    variants: {
      variant: {
        pill: "rounded-md px-3 py-1 data-[state=active]:bg-card data-[state=active]:shadow-sm",
        underline:
          "relative -mb-px shrink-0 rounded-t-md border-b-2 border-transparent px-3 py-2 data-[state=active]:border-primary",
      },
    },
    defaultVariants: { variant: "pill" },
  },
);

function TabsList({
  className,
  variant,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> & VariantProps<typeof listVariants>) {
  return <TabsPrimitive.List className={cn(listVariants({ variant }), className)} {...props} />;
}

function TabsTrigger({
  className,
  variant,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger> & VariantProps<typeof triggerVariants>) {
  return (
    <TabsPrimitive.Trigger className={cn(triggerVariants({ variant }), className)} {...props} />
  );
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cn("flex flex-col gap-4", className)} {...props} />;
}

export { Tabs, TabsContent, TabsList, TabsTrigger };
