import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { AuthLayout } from "@/components/auth-layout";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

type Tone = "info" | "success" | "danger";

const TONES: Record<Tone, string> = {
  info: "bg-accent text-brand-text",
  success: "bg-success-soft text-success-text",
  danger: "bg-danger-soft text-destructive-text",
};

/**
 * Cartão de estado das telas de entrada (sucesso, link expirado, carregando...), dentro do `AuthLayout`.
 * `busy` mostra o spinner no lugar do ícone e marca a região como ocupada para leitores de tela.
 */
export function StatusCard({
  icon: Icon,
  tone = "info",
  busy,
  title,
  description,
  children,
  actions,
}: {
  icon?: LucideIcon;
  tone?: Tone;
  busy?: boolean;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <AuthLayout>
      <Card className="gap-5 shadow-lg" aria-busy={busy || undefined}>
        <CardHeader>
          <span
            className={cn(
              "mb-1 flex size-11 items-center justify-center rounded-full",
              TONES[tone],
            )}
          >
            {busy ? (
              <Spinner className="size-5" />
            ) : Icon ? (
              <Icon className="size-5" aria-hidden />
            ) : null}
          </span>
          <CardTitle className="text-2xl">{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </CardHeader>
        {children ? <CardContent className="flex flex-col gap-4">{children}</CardContent> : null}
        {actions ? <CardFooter className="flex-col gap-3 sm:flex-row">{actions}</CardFooter> : null}
      </Card>
    </AuthLayout>
  );
}
