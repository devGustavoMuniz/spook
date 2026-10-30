import { zodResolver } from "@hookform/resolvers/zod";
import { getGetMeQueryKey, isApiError, useLogin } from "@spook/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { AuthLayout } from "@/components/auth-layout";
import { describedBy, Field } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { messageFor } from "@/lib/errors";
import { type LoginForm, loginSchema } from "@/lib/schemas";

export function LoginPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const login = useLogin();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<LoginForm>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  });

  const onSubmit = handleSubmit(async (data) => {
    try {
      const res = await login.mutateAsync({ data });
      qc.setQueryData(getGetMeQueryKey(), res.user);
      await navigate({ to: "/" });
    } catch (e) {
      if (isApiError(e) && e.status === 401) setError("root", { message: messageFor(e) });
      else toast.error(messageFor(e));
    }
  });

  return (
    <AuthLayout>
      <Card>
        <CardHeader>
          <CardTitle>Entrar</CardTitle>
        </CardHeader>
        <form onSubmit={onSubmit} noValidate>
          <CardContent className="flex flex-col gap-4">
            {errors.root ? (
              <p
                role="alert"
                className="rounded-md border border-destructive-text/40 p-3 text-sm text-destructive-text"
              >
                {errors.root.message}
              </p>
            ) : null}
            <Field id="email" label="E-mail" error={errors.email?.message}>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                aria-invalid={!!errors.email}
                aria-describedby={describedBy("email", errors.email?.message)}
                {...register("email")}
              />
            </Field>
            <Field id="password" label="Senha" error={errors.password?.message}>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                aria-invalid={!!errors.password}
                aria-describedby={describedBy("password", errors.password?.message)}
                {...register("password")}
              />
            </Field>
          </CardContent>
          <CardFooter className="mt-6 flex-col gap-3">
            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {isSubmitting ? "Entrando…" : "Entrar"}
            </Button>
            <p className="text-sm text-muted-foreground">
              Não tem conta?{" "}
              <Link
                to="/register"
                className="font-medium text-primary underline-offset-4 hover:underline"
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
