import { zodResolver } from "@hookform/resolvers/zod";
import { isApiError, useResetPassword } from "@spook/shared";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { CircleCheck, LinkIcon, TimerOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { FormAlert } from "@/auth/form-alert";
import { PasswordInput } from "@/auth/password-input";
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
import { useT } from "@/i18n";
import { messageFor } from "@/lib/errors";
import { type ResetForm, resetSchema } from "@/lib/schemas";

type Phase = "form" | "done" | "expired" | "invalid";

/**
 * Link do e-mail (`/reset-password?token=`). O token é lido uma vez, guardado só em memória e retirado da URL
 * (não fica no histórico nem vai em `Referer`); depois só trafega no corpo do POST.
 */
export function ResetPasswordPage() {
  const { t } = useT();
  const { token: urlToken } = useSearch({ strict: false }) as { token?: string };
  const navigate = useNavigate();
  const token = useRef(urlToken);
  if (urlToken && token.current !== urlToken) token.current = urlToken;
  useEffect(() => {
    if (urlToken) void navigate({ to: "/reset-password", search: {}, replace: true });
  }, [urlToken, navigate]);

  const reset = useResetPassword();
  const [phase, setPhase] = useState<Phase>(token.current ? "form" : "invalid");
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ResetForm>({
    resolver: zodResolver(resetSchema),
    mode: "onTouched",
    defaultValues: { new_password: "", confirm: "" },
  });

  const onSubmit = handleSubmit(async ({ new_password }) => {
    if (!token.current) return setPhase("invalid");
    try {
      await reset.mutateAsync({ data: { token: token.current, new_password } });
      token.current = undefined;
      setPhase("done");
    } catch (e) {
      if (isApiError(e) && e.status === 410)
        setPhase(e.code === "token_expired" ? "expired" : "invalid");
      else if (isApiError(e) && e.status === 422)
        setError("new_password", { message: t("auth.reset.passwordRange") });
      else setError("root", { message: messageFor(e) });
    }
  });

  if (phase === "done")
    return (
      <StatusCard
        icon={CircleCheck}
        tone="success"
        title={t("auth.reset.doneTitle")}
        description={t("auth.reset.doneBody")}
        actions={
          <Button asChild size="lg">
            <Link to="/login">{t("auth.signIn")}</Link>
          </Button>
        }
      />
    );
  if (phase === "expired" || phase === "invalid")
    return (
      <StatusCard
        icon={phase === "expired" ? TimerOff : LinkIcon}
        tone="danger"
        title={phase === "expired" ? t("auth.reset.expiredTitle") : t("auth.reset.invalidTitle")}
        description={
          phase === "expired" ? t("auth.reset.expiredBody") : t("auth.reset.invalidBody")
        }
        actions={
          <Button asChild size="lg">
            <Link to="/forgot-password">{t("auth.reset.newLink")}</Link>
          </Button>
        }
      />
    );

  const busy = isSubmitting;
  return (
    <AuthLayout>
      <Card className="gap-5 shadow-lg">
        <CardHeader>
          <CardTitle className="text-2xl">{t("auth.reset.title")}</CardTitle>
          <CardDescription>{t("auth.reset.subtitle")}</CardDescription>
        </CardHeader>
        <form onSubmit={onSubmit} noValidate aria-busy={busy || undefined}>
          <CardContent className="flex flex-col gap-4">
            {errors.root ? <FormAlert>{errors.root.message}</FormAlert> : null}
            <Field
              id="new_password"
              label={t("auth.reset.newPassword")}
              error={errors.new_password?.message}
              hint={t("auth.register.passwordHint")}
            >
              <PasswordInput
                id="new_password"
                autoComplete="new-password"
                size="lg"
                disabled={busy}
                aria-invalid={!!errors.new_password}
                aria-describedby={describedBy("new_password", errors.new_password?.message, "hint")}
                {...register("new_password")}
              />
            </Field>
            <Field id="confirm" label={t("auth.reset.repeat")} error={errors.confirm?.message}>
              <PasswordInput
                id="confirm"
                autoComplete="new-password"
                size="lg"
                disabled={busy}
                aria-invalid={!!errors.confirm}
                aria-describedby={describedBy("confirm", errors.confirm?.message)}
                {...register("confirm")}
              />
            </Field>
          </CardContent>
          <CardFooter className="mt-6 flex-col gap-4">
            <Button type="submit" size="xl" className="w-full" loading={busy}>
              {t("auth.reset.submit")}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </AuthLayout>
  );
}
