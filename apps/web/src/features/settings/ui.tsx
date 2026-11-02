import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/** Grupo de configurações: cartão com ícone, título (h2), ajuda curta e o conteúdo. */
export function SettingsGroup({
  icon: Icon,
  title,
  description,
  children,
  className,
}: {
  icon: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("gap-4 py-5", className)}>
      <CardHeader className="grid grid-cols-[auto_1fr] items-start gap-x-3 gap-y-1 px-5">
        <span className="row-span-2 flex size-9 items-center justify-center rounded-lg bg-accent text-brand-text">
          <Icon className="size-[18px]" aria-hidden />
        </span>
        <CardTitle as="h2" className="self-center text-base">
          {title}
        </CardTitle>
        {description ? (
          <CardDescription className="col-start-2 text-pretty">{description}</CardDescription>
        ) : null}
      </CardHeader>
      {children ? <CardContent className="flex flex-col gap-4 px-5">{children}</CardContent> : null}
    </Card>
  );
}

/** Linha rótulo + ajuda à esquerda e controle à direita (empilha em tela estreita se `stack`). */
export function SettingRow({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <label htmlFor={htmlFor} className="flex min-w-0 flex-col gap-0.5 text-sm font-medium">
        {label}
        {hint ? (
          <span className="text-xs font-normal text-pretty text-muted-foreground">{hint}</span>
        ) : null}
      </label>
      {children}
    </div>
  );
}

/** Texto de ajuda fora de uma linha. */
export function Hint({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("text-xs text-pretty text-muted-foreground", className)}>{children}</p>;
}

/** Lista de opções em cartões (radio nativo: teclado e leitor de tela de graça). */
export function ChoiceCard({
  id,
  name,
  checked,
  disabled,
  onChange,
  title,
  hint,
}: {
  id: string;
  name: string;
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
  title: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <label
      htmlFor={id}
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-lg border bg-surface-1 px-3 py-2.5 text-sm transition-colors hover:border-brand-400 has-[:checked]:border-primary has-[:checked]:bg-accent has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
        disabled && "cursor-not-allowed opacity-60 hover:border-border",
      )}
    >
      <input
        id={id}
        type="radio"
        name={name}
        className="mt-1 accent-primary"
        checked={checked}
        disabled={disabled}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={onChange}
      />
      <span className="flex flex-col">
        <span className="font-medium">{title}</span>
        {hint ? (
          <span id={`${id}-hint`} className="text-xs text-muted-foreground">
            {hint}
          </span>
        ) : null}
      </span>
    </label>
  );
}

/** Seletor nativo com o visual do design system. */
export const selectClass =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground";
