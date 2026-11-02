// Classes compartilhadas por dropdown, menu de contexto e select: um só visual para "lista de ações".
// Entrada/saída usam transform + opacity (animações `pop-in`/`pop-out` do tema) a partir da origem do Radix.
export const menuContent =
  "z-[var(--z-popover)] min-w-48 origin-[var(--radix-popper-transform-origin)] overflow-hidden rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out";

export const menuItem =
  "relative flex items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none data-[disabled]:pointer-events-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[state=open]:bg-accent [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground data-[highlighted]:[&_svg]:text-current";

export const menuItemDestructive =
  "text-destructive-text data-[highlighted]:bg-danger-soft data-[highlighted]:text-destructive-text [&_svg]:text-current";

export const menuLabel = "px-2 py-1.5 text-xs font-medium text-muted-foreground";
export const menuSeparator = "-mx-1 my-1 h-px bg-border";
export const menuShortcut = "ml-auto pl-4 text-xs tracking-wide text-muted-foreground";
