import type * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Estado vazio / erro: ilustração (slot), título, descrição e ação.
 * Use com as ilustrações de `components/illustrations` ou um ícone; ocupa o espaço disponível e centraliza.
 */
function EmptyState({
  illustration,
  title,
  description,
  action,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "title"> & {
  illustration?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex size-full min-h-0 flex-col items-center justify-center gap-3 p-6 text-center",
        className,
      )}
      {...props}
    >
      {illustration ? <div className="mb-1 flex justify-center">{illustration}</div> : null}
      <h2 className="text-lg font-semibold tracking-tight text-balance">{title}</h2>
      {description ? (
        <p className="max-w-sm text-sm text-muted-foreground text-pretty">{description}</p>
      ) : null}
      {action ? (
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2">{action}</div>
      ) : null}
    </div>
  );
}

export { EmptyState };
