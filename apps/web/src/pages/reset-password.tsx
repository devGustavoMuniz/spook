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
import { messageFor } from "@/lib/errors";
import { type ResetForm, resetSchema } from "@/lib/schemas";

type Phase = "form" | "done" | "expired" | "invalid";

/**
 * Link do e-mail (`/reset-password?token=`). O token é lido uma vez, guardado só em memória e retirado da URL
 * (não fica no histórico nem vai em `Referer`); depois só trafega no corpo do POST.
 */
export function ResetPasswordPage() {
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
        setError("new_password", { message: "A senha precisa ter de 8 a 128 caracteres." });
      else setError("root", { message: messageFor(e) });
    }
  });

  if (phase === "done")
    return (
      <StatusCard
        icon={CircleCheck}
        tone="success"
        title="Senha redefinida"
        description="Sua senha foi alterada e todos os dispositivos foram desconectados. Entre com a senha nova."
        actions={
          <Button asChild size="lg">
            <Link to="/login">Entrar</Link>
          </Button>
        }
      />
    );
  if (phase === "expired" || phase === "invalid")
    return (
      <StatusCard
        icon={phase === "expired" ? TimerOff : LinkIcon}
        tone="danger"
        title={phase === "expired" ? "Link expirado" : "Link inválido"}
        description={
          phase === "expired"
            ? "Este link já foi usado ou passou dos 30 minutos. Peça um novo."
            : "O link está incompleto ou não existe mais. Peça um novo."
        }
        actions={
          <Button asChild size="lg">
            <Link to="/forgot-password">Pedir novo link</Link>
          </Button>
        }
      />
    );

  const busy = isSubmitting;
  return (
    <AuthLayout>
      <Card className="gap-5 shadow-lg">
        <CardHeader>
          <CardTitle className="text-2xl">Criar nova senha</CardTitle>
          <CardDescription>
            Escolha uma senha nova. Ao concluir, todos os dispositivos conectados serão
            desconectados.
          </CardDescription>
        </CardHeader>
        <form onSubmit={onSubmit} noValidate aria-busy={busy || undefined}>
          <CardContent className="flex flex-col gap-4">
            {errors.root ? <FormAlert>{errors.root.message}</FormAlert> : null}
            <Field
              id="new_password"
              label="Nova senha"
              error={errors.new_password?.message}
              hint="Mínimo de 8 caracteres."
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
            <Field id="confirm" label="Repita a nova senha" error={errors.confirm?.message}>
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
              Redefinir senha
            </Button>
          </CardFooter>
        </form>
      </Card>
    </AuthLayout>
  );
}
