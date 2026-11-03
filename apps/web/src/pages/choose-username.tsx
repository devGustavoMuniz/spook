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
import { applyServerError, messageFor } from "@/lib/errors";
import { type ChooseUsernameForm, chooseUsernameSchema } from "@/lib/schemas";

const PROVIDERS: Record<string, string> = { google: "Google", discord: "Discord" };

/** "Escolha seu username": conclui o cadastro social (conta sem senha, e-mail já verificado pelo provedor). */
export function ChooseUsernamePage() {
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
        setError("username", { message: "Esse nome não pode ser usado. Escolha outro." });
      else if (!applyServerError(e, setError)) setError("root", { message: messageFor(e) });
    }
  });

  if (pending.isPending)
    return <StatusCard busy title="Carregando…" description="Só um instante." />;
  if (pending.isError)
    return (
      <StatusCard
        icon={TimerOff}
        tone="danger"
        title="Cadastro expirado"
        description="O cadastro com o provedor expirou (vale 15 minutos). Entre com ele de novo para continuar."
        actions={
          <Button asChild size="lg">
            <Link to="/login">Voltar para entrar</Link>
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
          <CardTitle className="text-2xl">Escolha seu username</CardTitle>
          <CardDescription>
            Você entrou com o {provider} como {pending.data.email}. Falta só escolher como as
            pessoas vão te encontrar.
          </CardDescription>
        </CardHeader>
        <form onSubmit={onSubmit} noValidate aria-busy={busy || undefined}>
          <CardContent className="flex flex-col gap-4">
            {errors.root ? <FormAlert>{errors.root.message}</FormAlert> : null}
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
              Concluir cadastro
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              Sua conta não terá senha: você entra pelo {provider}. Dá para definir uma senha depois
              em Configurações.
            </p>
          </CardFooter>
        </form>
      </Card>
    </AuthLayout>
  );
}
