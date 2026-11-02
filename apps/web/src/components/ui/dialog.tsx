import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cva, type VariantProps } from "class-variance-authority";
import { type LucideIcon, X } from "lucide-react";
import type * as React from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
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

/**
 * `flush` zera o padding e o espaçamento: o diálogo vira cabeçalho (`DialogHead`) + corpo rolável
 * (`DialogBody`) + rodapé fixo (`DialogActions`), cada um com o seu padding.
 */
function DialogContent({
  className,
  children,
  size,
  flush,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> &
  VariantProps<typeof dialogVariants> & { flush?: boolean }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className={overlayClass} />
      <DialogPrimitive.Content
        className={cn(dialogVariants({ size }), flush && "gap-0 overflow-hidden p-0", className)}
        {...props}
      >
        {children}
        <DialogPrimitive.Close
          aria-label="Fechar"
          className="absolute top-3.5 right-3.5 z-10 inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
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

/** Cabeçalho de diálogo `flush`: ícone em ladrilho, título, descrição e (opcional) um slot à direita do título. */
function DialogHead({
  icon: Icon,
  title,
  description,
  className,
  children,
}: {
  icon?: LucideIcon;
  title: React.ReactNode;
  description?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className={cn("flex shrink-0 items-start gap-3 px-6 pt-6 pr-14 pb-4", className)}>
      {Icon ? (
        <span
          aria-hidden
          className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent text-brand-text"
        >
          <Icon className="size-5" />
        </span>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <DialogTitle>{title}</DialogTitle>
        {description ? <DialogDescription>{description}</DialogDescription> : null}
        {children}
      </div>
    </div>
  );
}

/** Corpo rolável (barras finas do `ScrollArea`); só ele rola, o cabeçalho e o rodapé ficam fixos. */
function DialogBody({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <ScrollArea className="min-h-0 flex-1 border-y border-transparent">
      <div className={cn("flex flex-col gap-5 px-6 py-4", className)}>{children}</div>
    </ScrollArea>
  );
}

/** Rodapé fixo: secundário à esquerda do primário; destrutivo vai separado (`DialogActions` aceita `start`). */
function DialogActions({
  className,
  start,
  children,
}: {
  className?: string;
  /** Ação que fica no extremo esquerdo (ex.: excluir). */
  start?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex shrink-0 flex-col-reverse gap-2 border-t border-border bg-surface-1 px-6 py-3.5 sm:flex-row sm:items-center",
        className,
      )}
    >
      {start ? <div className="sm:mr-auto">{start}</div> : null}
      <div className="flex flex-col-reverse gap-2 sm:ml-auto sm:flex-row sm:flex-wrap sm:justify-end">
        {children}
      </div>
    </div>
  );
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
  DialogActions,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHead,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  dialogVariants,
  overlayClass,
};
