import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cva, type VariantProps } from "class-variance-authority";
import { X } from "lucide-react";
import type * as React from "react";
import { cn } from "@/lib/utils";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogClose = DialogPrimitive.Close;

/** Fundo escurecido, com fade (opacity). Compartilhado pelo AlertDialog. */
const overlayClass =
  "fixed inset-0 z-[var(--z-overlay)] bg-overlay data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out";

const dialogVariants = cva(
  "fixed top-1/2 left-1/2 z-[var(--z-modal)] flex max-h-[90svh] w-[calc(100%-1.5rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-xl border border-border bg-popover p-6 text-popover-foreground shadow-xl data-[state=open]:animate-dialog-in data-[state=closed]:animate-dialog-out",
  {
    variants: {
      size: {
        sm: "max-w-sm",
        md: "max-w-lg",
        lg: "max-w-2xl",
        xl: "max-w-4xl",
        full: "max-h-[calc(100svh-1.5rem)] max-w-[calc(100%-1.5rem)]",
      },
    },
    defaultVariants: { size: "md" },
  },
);

function DialogContent({
  className,
  children,
  size,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & VariantProps<typeof dialogVariants>) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className={overlayClass} />
      <DialogPrimitive.Content className={cn(dialogVariants({ size }), className)} {...props}>
        {children}
        <DialogPrimitive.Close
          aria-label="Fechar"
          className="absolute top-3.5 right-3.5 inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-4" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-1.5 pr-8", className)} {...props} />;
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:justify-end",
        className,
      )}
      {...props}
    />
  );
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn("text-lg leading-tight font-semibold tracking-tight", className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  dialogVariants,
  overlayClass,
};
