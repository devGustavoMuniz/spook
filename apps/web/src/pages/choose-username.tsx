import { zodResolver } from "@hookform/resolvers/zod";
import {
  getGetMeQueryKey,
  isApiError,
  useSocialSignupComplete,
  useSocialSignupPending,
} from "@spook/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouter, useSearch } from "@tanstack/react-router";
import { TimerOff } from "lucide-react";
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
import { applyServerError, messageFor } from "@/lib/errors";
import { type ChooseUsernameForm, chooseUsernameSchema } from "@/lib/schemas";

const PROVIDERS: Record<string, string> = { google: "Google", discord: "Discord" };

/** "Escolha seu username": conclui o cadastro social (conta sem senha, e-mail já verificado pelo provedor). */
export function ChooseUsernamePage() {
  const { t } = useT();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const router = useRouter();
  const { redirect } = useSearch({ strict: false }) as { redirect?: string };
  const pending = useSocialSignupPending({ query: { retry: false, staleTime: Infinity } });
  const complete = useSocialSignupComplete();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ChooseUsernameForm>({
    resolver: zodResolver(chooseUsernameSchema),
    mode: "onTouched",
    // A sugestão do servidor preenche o campo quando chega, sem sobrescrever o que a pessoa já digitou.
    values: { username: pending.data?.suggested_username ?? "" },
    resetOptions: { keepDirtyValues: true },
  });

  const onSubmit = handleSubmit(async (data) => {
    try {
      const res = await complete.mutateAsync({ data });
      qc.setQueryData(getGetMeQueryKey(), res.user);
      if (redirect) router.history.push(redirect);
      else await navigate({ to: "/" });
    } catch (e) {
      if (isApiError(e) && e.status === 410) void pending.refetch();
      else if (isApiError(e) && e.status === 422)
        setError("username", { message: t("auth.choose.taken") });
      else if (!applyServerError(e, setError)) setError("root", { message: messageFor(e) });
    }
  });

  if (pending.isPending)
    return <StatusCard busy title={t("common.loading")} description={t("auth.verify.moment")} />;
  if (pending.isError)
    return (
      <StatusCard
        icon={TimerOff}
        tone="danger"
        title={t("auth.choose.expiredTitle")}
        description={t("auth.choose.expiredBody")}
        actions={
          <Button asChild size="lg">
            <Link to="/login">{t("auth.forgot.backToSignIn")}</Link>
          </Button>
        }
      />
    );

  const provider = PROVIDERS[pending.data.provider] ?? pending.data.provider;
  const busy = isSubmitting;
  return (
    <AuthLayout>
      <Card className="gap-5 shadow-lg">
        <CardHeader>
          <CardTitle className="text-2xl">{t("auth.choose.title")}</CardTitle>
          <CardDescription>
            {t("auth.choose.body", { provider, email: pending.data.email })}
          </CardDescription>
        </CardHeader>
        <form onSubmit={onSubmit} noValidate aria-busy={busy || undefined}>
          <CardContent className="flex flex-col gap-4">
            {errors.root ? <FormAlert>{errors.root.message}</FormAlert> : null}
            <Field
              id="username"
              label={t("auth.register.username")}
              error={errors.username?.message}
              hint={t("auth.register.usernameHint")}
            >
              <Input
                id="username"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                size="lg"
                disabled={busy}
                aria-invalid={!!errors.username}
                aria-describedby={describedBy("username", errors.username?.message, "hint")}
                {...register("username")}
              />
            </Field>
          </CardContent>
          <CardFooter className="mt-6 flex-col gap-4">
            <Button type="submit" size="xl" className="w-full" loading={busy}>
              {t("auth.choose.submit")}
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              {t("auth.choose.noPassword", { provider })}
            </p>
          </CardFooter>
        </form>
      </Card>
    </AuthLayout>
  );
}
