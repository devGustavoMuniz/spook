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
import { useT } from "@/i18n";
import { messageFor } from "@/lib/errors";
import { type ForgotForm, forgotSchema } from "@/lib/schemas";

/** "Esqueci minha senha": a resposta é a mesma exista ou não a conta (o servidor não revela contas). */
export function ForgotPasswordPage() {
  const { t } = useT();
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
        title={t("auth.forgot.checkTitle")}
        description={t("auth.forgot.sent", { email: sentTo })}
        actions={
          <Button asChild variant="outline" size="lg">
            <Link to="/login">{t("auth.forgot.backToSignIn")}</Link>
          </Button>
        }
      >
        <p className="text-sm text-muted-foreground">{t("auth.forgot.spam")}</p>
      </StatusCard>
    );
  }

  const busy = isSubmitting;
  return (
    <AuthLayout>
      <Card className="gap-5 shadow-lg">
        <CardHeader>
          <CardTitle className="text-2xl">{t("auth.login.forgot")}</CardTitle>
          <CardDescription>{t("auth.forgot.subtitle")}</CardDescription>
        </CardHeader>
        <form onSubmit={onSubmit} noValidate aria-busy={busy || undefined}>
          <CardContent className="flex flex-col gap-4">
            {providers && !providers.email_enabled ? (
              <div className="flex items-start gap-2.5 rounded-md border border-border bg-accent p-3 text-sm">
                <Info className="mt-0.5 size-4 shrink-0 text-brand-text" aria-hidden="true" />
                <p>{t("auth.forgot.noEmail")}</p>
              </div>
            ) : null}
            {errors.root ? <FormAlert>{errors.root.message}</FormAlert> : null}
            <Field id="email" label={t("common.email")} error={errors.email?.message}>
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
              {t("auth.forgot.sendLink")}
            </Button>
            <Link
              to="/login"
              className="text-sm font-medium text-brand-text underline-offset-4 hover:underline"
            >
              {t("auth.forgot.backToSignIn")}
            </Link>
          </CardFooter>
        </form>
      </Card>
    </AuthLayout>
  );
}
