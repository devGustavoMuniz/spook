import { zodResolver } from "@hookform/resolvers/zod";
import { getGetMeQueryKey, useLogin } from "@spook/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouter, useSearch } from "@tanstack/react-router";
import { useForm } from "react-hook-form";
import { FormAlert } from "@/auth/form-alert";
import { InviteBanner, inviteCodeOf } from "@/auth/invite-banner";
import { PasswordInput } from "@/auth/password-input";
import { SocialButtons } from "@/auth/social-buttons";
import { socialErrorMessage } from "@/auth/social-errors";
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
import { BrowserLoginButton } from "@/desktop/browser-login-button";
import { persistSessionToken } from "@/desktop/token";
import { messageFor } from "@/lib/errors";
import { type LoginForm, loginSchema } from "@/lib/schemas";

export function LoginPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const router = useRouter();
  const { redirect, social_error } = useSearch({ strict: false }) as {
    redirect?: string;
    social_error?: string;
  };
  const socialError = socialErrorMessage(social_error);
  const login = useLogin();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<LoginForm>({
    resolver: zodResolver(loginSchema),
    mode: "onTouched",
    defaultValues: { email: "", password: "" },
  });

  const onSubmit = handleSubmit(async (data) => {
    try {
      const res = await login.mutateAsync({ data });
      await persistSessionToken(res.token);
      qc.setQueryData(getGetMeQueryKey(), res.user);
      if (redirect) router.history.push(redirect);
      else await navigate({ to: "/" });
    } catch (e) {
      setError("root", { message: messageFor(e) });
    }
  });

  const busy = isSubmitting;
  return (
    <AuthLayout>
      <Card className="gap-5 shadow-lg">
        <CardHeader>
          <CardTitle className="text-2xl">Entrar</CardTitle>
          <CardDescription>Bem-vindo de volta. Entre para falar com a sua galera.</CardDescription>
        </CardHeader>
        <form onSubmit={onSubmit} noValidate aria-busy={busy || undefined}>
          <CardContent className="flex flex-col gap-4">
            {inviteCodeOf(redirect) && redirect ? (
              <InviteBanner redirect={redirect} current="login" />
            ) : null}
            {socialError ? <FormAlert>{socialError}</FormAlert> : null}
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
            <Field id="password" label="Senha" error={errors.password?.message}>
              <PasswordInput
                id="password"
                autoComplete="current-password"
                size="lg"
                disabled={busy}
                aria-invalid={!!errors.password}
                aria-describedby={describedBy("password", errors.password?.message)}
                {...register("password")}
              />
            </Field>
            <Link
              to="/forgot-password"
              className="self-start text-sm font-medium text-brand-text underline-offset-4 hover:underline"
            >
              Esqueci minha senha
            </Link>
          </CardContent>
          <CardFooter className="mt-6 flex-col gap-4">
            <Button type="submit" size="xl" className="w-full" loading={busy}>
              Entrar
            </Button>
            <SocialButtons redirect={redirect} />
            <BrowserLoginButton />
            <p className="text-sm text-muted-foreground">
              Não tem conta?{" "}
              <Link
                to="/register"
                search={{ redirect }}
                className="font-medium text-brand-text underline-offset-4 hover:underline"
              >
                Cadastre-se
              </Link>
            </p>
          </CardFooter>
        </form>
      </Card>
    </AuthLayout>
  );
}
