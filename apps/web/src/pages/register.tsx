import { zodResolver } from "@hookform/resolvers/zod";
import { getGetMeQueryKey, useRegister } from "@spook/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouter, useSearch } from "@tanstack/react-router";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { AuthLayout } from "@/components/auth-layout";
import { describedBy, Field } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { persistSessionToken } from "@/desktop/token";
import { applyServerError, messageFor } from "@/lib/errors";
import { type RegisterForm, registerSchema } from "@/lib/schemas";

export function RegisterPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const router = useRouter();
  const { redirect } = useSearch({ strict: false }) as { redirect?: string };
  const registerUser = useRegister();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<RegisterForm>({
    resolver: zodResolver(registerSchema),
    defaultValues: { email: "", username: "", password: "" },
  });

  const onSubmit = handleSubmit(async (data) => {
    try {
      const res = await registerUser.mutateAsync({ data });
      await persistSessionToken(res.token);
      qc.setQueryData(getGetMeQueryKey(), res.user);
      if (redirect) router.history.push(redirect);
      else await navigate({ to: "/" });
    } catch (e) {
      if (!applyServerError(e, setError)) toast.error(messageFor(e));
    }
  });

  return (
    <AuthLayout>
      <Card>
        <CardHeader>
          <CardTitle>Criar conta</CardTitle>
        </CardHeader>
        <form onSubmit={onSubmit} noValidate>
          <CardContent className="flex flex-col gap-4">
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
            <Field
              id="username"
              label="Nome de usuário"
              error={errors.username?.message}
              hint="2 a 32 caracteres: a-z, 0-9, _ e ."
            >
              <Input
                id="username"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                aria-invalid={!!errors.username}
                aria-describedby={describedBy("username", errors.username?.message, "hint")}
                {...register("username")}
              />
            </Field>
            <Field
              id="password"
              label="Senha"
              error={errors.password?.message}
              hint="Mínimo de 8 caracteres."
            >
              <Input
                id="password"
                type="password"
                autoComplete="new-password"
                aria-invalid={!!errors.password}
                aria-describedby={describedBy("password", errors.password?.message, "hint")}
                {...register("password")}
              />
            </Field>
          </CardContent>
          <CardFooter className="mt-6 flex-col gap-3">
            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {isSubmitting ? "Criando conta…" : "Criar conta"}
            </Button>
            <p className="text-sm text-muted-foreground">
              Já tem conta?{" "}
              <Link
                to="/login"
                search={{ redirect }}
                className="font-medium text-primary underline-offset-4 hover:underline"
              >
                Entrar
              </Link>
            </p>
          </CardFooter>
        </form>
      </Card>
    </AuthLayout>
  );
}
