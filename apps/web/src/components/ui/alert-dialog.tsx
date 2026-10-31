import * as AlertPrimitive from "@radix-ui/react-alert-dialog";
import type * as React from "react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const AlertDialog = AlertPrimitive.Root;
const AlertDialogTrigger = AlertPrimitive.Trigger;

function AlertDialogContent({
  className,
  ...props
}: React.ComponentProps<typeof AlertPrimitive.Content>) {
  return (
    <AlertPrimitive.Portal>
      <AlertPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60" />
      <AlertPrimitive.Content
        className={cn(
          "fixed top-1/2 left-1/2 z-50 flex w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-lg border bg-popover p-6 text-popover-foreground shadow-lg",
          className,
        )}
        {...props}
      />
    </AlertPrimitive.Portal>
  );
}

function AlertDialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof AlertPrimitive.Title>) {
  return <AlertPrimitive.Title className={cn("text-lg font-semibold", className)} {...props} />;
}

function AlertDialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof AlertPrimitive.Description>) {
  return (
    <AlertPrimitive.Description
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

function AlertDialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex flex-wrap justify-end gap-2", className)} {...props} />;
}

function AlertDialogCancel({
  className,
  ...props
}: React.ComponentProps<typeof AlertPrimitive.Cancel>) {
  return (
    <AlertPrimitive.Cancel
      className={cn(buttonVariants({ variant: "outline" }), className)}
      {...props}
    />
  );
}

function AlertDialogAction({
  className,
  variant = "destructive",
  ...props
}: React.ComponentProps<typeof AlertPrimitive.Action> & {
  variant?: "default" | "destructive";
}) {
  return (
    <AlertPrimitive.Action className={cn(buttonVariants({ variant }), className)} {...props} />
  );
}

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogTrigger,
};
