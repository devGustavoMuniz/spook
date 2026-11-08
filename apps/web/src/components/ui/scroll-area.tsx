import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import type * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Rolagem com barra fina, visível sempre que há o que rolar (`type="auto"`). Para listas internas; a página usa a
 * barra do CSS base.
 *
 * O `Root` é uma coluna flex e o `Viewport` ocupa o que sobra (`flex-1 min-h-0`), em vez de `height: 100%`: dentro
 * de um pai com `max-height` (diálogo) a altura do `Root` não é "definida" para porcentagens, o `100%` virava
 * `auto`, o viewport crescia até o conteúdo inteiro e o `overflow-hidden` do `Root` apenas cortava o excesso (nada
 * rolava). `overscroll-contain` impede que a roda "vaze" para a página/palco atrás quando chega ao fim.
 */
function ScrollArea({
  className,
  children,
  type = "auto",
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root>) {
  return (
    <ScrollAreaPrimitive.Root
      type={type}
      className={cn("relative flex flex-col overflow-hidden", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport className="min-h-0 w-full flex-1 overscroll-contain rounded-[inherit]">
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Scrollbar>) {
  return (
    <ScrollAreaPrimitive.Scrollbar
      orientation={orientation}
      className={cn(
        "flex touch-none p-0.5 select-none transition-opacity data-[state=hidden]:opacity-0",
        orientation === "vertical" ? "h-full w-2.5" : "h-2.5 flex-col",
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-scroll-thumb hover:bg-scroll-thumb-hover" />
    </ScrollAreaPrimitive.Scrollbar>
  );
}

export { ScrollArea, ScrollBar };
