import { zodResolver } from "@hookform/resolvers/zod";
import { useAuthProviders, useForgotPassword } from "@spook/shared";
import { Link } from "@tanstack/react-router";
import { Info, MailCheck } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { FormAlert } from "@/auth/form-alert";
import { StatusCard } from "@/auth/status-card";
import { AuthLayout } from "@/components/auth-layout";
import { describedBy, Field } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { messageFor } from "@/lib/errors";
import { type ForgotForm, forgotSchema } from "@/lib/schemas";

/** "Esqueci minha senha": a resposta é a mesma exista ou não a conta (o servidor não revela contas). */
export function ForgotPasswordPage() {
  const forgot = useForgotPassword();
  const { data: providers } = useAuthProviders({ query: { staleTime: 60_000 } });
  const [sentTo, setSentTo] = useState<string>();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ForgotForm>({
    resolver: zodResolver(forgotSchema),
    mode: "onTouched",
    defaultValues: { email: "" },
  });

  const onSubmit = handleSubmit(async ({ email }) => {
    try {
      await forgot.mutateAsync({ data: { email } });
      setSentTo(email);
    } catch (e) {
      setError("root", { message: messageFor(e) });
    }
  });

  if (sentTo) {
    return (
      <StatusCard
        icon={MailCheck}
        tone="success"
        title="Confira seu e-mail"
        description={`Se existir uma conta com ${sentTo}, enviamos um link para redefinir a senha. Ele vale por 30 minutos e só pode ser usado uma vez.`}
        actions={
          <Button asChild variant="outline" size="lg">
            <Link to="/login">Voltar para entrar</Link>
          </Button>
        }
      >
        <p className="text-sm text-muted-foreground">
          Não chegou? Veja a caixa de spam e tente de novo em alguns minutos.
        </p>
      </StatusCard>
    );
  }

  const busy = isSubmitting;
  return (
    <AuthLayout>
      <Card className="gap-5 shadow-lg">
        <CardHeader>
          <CardTitle className="text-2xl">Esqueci minha senha</CardTitle>
          <CardDescription>
            Informe o e-mail da sua conta e enviaremos um link para criar uma senha nova.
          </CardDescription>
        </CardHeader>
        <form onSubmit={onSubmit} noValidate aria-busy={busy || undefined}>
          <CardContent className="flex flex-col gap-4">
            {providers && !providers.email_enabled ? (
              <div className="flex items-start gap-2.5 rounded-md border border-border bg-accent p-3 text-sm">
                <Info className="mt-0.5 size-4 shrink-0 text-brand-text" aria-hidden="true" />
                <p>
                  Este servidor não envia e-mails. Peça ao administrador um link de redefinição de
                  senha.
                </p>
              </div>
            ) : null}
            {errors.root ? <FormAlert>{errors.root.message}</FormAlert> : null}
            <Field id="email" label="E-mail" error={errors.email?.message}>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                inputMode="email"
                size="lg"
                disabled={busy}
                aria-invalid={!!errors.email}
                aria-describedby={describedBy("email", errors.email?.message)}
                {...register("email")}
              />
            </Field>
          </CardContent>
          <CardFooter className="mt-6 flex-col gap-4">
            <Button type="submit" size="xl" className="w-full" loading={busy}>
              Enviar link
            </Button>
            <Link
              to="/login"
              className="text-sm font-medium text-brand-text underline-offset-4 hover:underline"
            >
              Voltar para entrar
            </Link>
          </CardFooter>
        </form>
      </Card>
    </AuthLayout>
  );
}
