import { zodResolver } from "@hookform/resolvers/zod";
import {
  getGetMeQueryKey,
  isApiError,
  useChangeEmail,
  useChangePassword,
  useDeleteMe,
  type View,
} from "@spook/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { KeyRound, Mail, Trash2 } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { describedBy, Field } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogHead,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { clearSessionToken } from "@/desktop/token";
import { isConfirmationCancelled, useConfirmPassword } from "@/features/account/confirm-password";
import { SettingsGroup } from "@/features/settings/ui";
import { messageFor } from "@/lib/errors";
import {
  type ChangeEmailForm,
  type ChangePasswordForm,
  changeEmailSchema,
  changePasswordSchema,
} from "@/lib/schemas";

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Cartões de segurança da conta: trocar senha, trocar e-mail e excluir conta. */
export function SecuritySection({ me }: { me: View }) {
  return (
    <>
      <ChangePasswordCard />
      <ChangeEmailCard me={me} />
      <DeleteAccountCard me={me} />
    </>
  );
}

function ChangePasswordCard() {
  const change = useChangePassword();
  const {
    register,
    handleSubmit,
    setError,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<ChangePasswordForm>({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: { current_password: "", new_password: "", confirm: "" },
  });

  const onSubmit = handleSubmit(async ({ current_password, new_password }) => {
    try {
      await change.mutateAsync({ data: { current_password, new_password } });
      reset();
      toast.success("Senha alterada. Os outros dispositivos foram desconectados.");
    } catch (e) {
      if (isApiError(e) && e.status === 422) {
        const field = /atual/i.test(e.detail) ? "current_password" : "new_password";
        setError(field, { message: capitalize(e.detail) });
      } else toast.error(messageFor(e));
    }
  });

  return (
    <SettingsGroup
      icon={KeyRound}
      title="Senha"
      description="Ao trocar a senha, os outros dispositivos conectados são desconectados; este continua."
    >
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <Field id="current_password" label="Senha atual" error={errors.current_password?.message}>
          <Input
            id="current_password"
            type="password"
            autoComplete="current-password"
            aria-invalid={!!errors.current_password}
            aria-describedby={describedBy("current_password", errors.current_password?.message)}
            {...register("current_password")}
          />
        </Field>
        <Field
          id="new_password"
          label="Nova senha"
          hint="De 8 a 128 caracteres."
          error={errors.new_password?.message}
        >
          <Input
            id="new_password"
            type="password"
            autoComplete="new-password"
            aria-invalid={!!errors.new_password}
            aria-describedby={describedBy(
              "new_password",
              errors.new_password?.message,
              "De 8 a 128 caracteres.",
            )}
            {...register("new_password")}
          />
        </Field>
        <Field id="confirm_password" label="Repita a nova senha" error={errors.confirm?.message}>
          <Input
            id="confirm_password"
            type="password"
            autoComplete="new-password"
            aria-invalid={!!errors.confirm}
            aria-describedby={describedBy("confirm_password", errors.confirm?.message)}
            {...register("confirm")}
          />
        </Field>
        <Button type="submit" className="self-start" loading={isSubmitting}>
          Trocar senha
        </Button>
      </form>
    </SettingsGroup>
  );
}

function ChangeEmailCard({ me }: { me: View }) {
  const qc = useQueryClient();
  const change = useChangeEmail();
  const { run } = useConfirmPassword();
  const {
    register,
    handleSubmit,
    setError,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<ChangeEmailForm>({
    resolver: zodResolver(changeEmailSchema),
    defaultValues: { email: me.email },
  });

  const onSubmit = handleSubmit(async ({ email }) => {
    if (email.trim().toLowerCase() === me.email.toLowerCase()) {
      setError("email", { message: "Este já é o seu e-mail." });
      return;
    }
    try {
      const res = await run(() => change.mutateAsync({ data: { email } }));
      qc.setQueryData(getGetMeQueryKey(), res);
      reset({ email: res.email });
      toast.success("E-mail alterado.");
    } catch (e) {
      if (isConfirmationCancelled(e)) return;
      if (isApiError(e) && (e.status === 409 || e.status === 422))
        setError("email", {
          message: e.status === 409 ? "E-mail já cadastrado." : "E-mail inválido.",
        });
      else toast.error(messageFor(e));
    }
  });

  return (
    <SettingsGroup
      icon={Mail}
      title="E-mail"
      description="Usado para entrar. Pedimos a sua senha para confirmar a troca."
    >
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
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
        <Button type="submit" className="self-start" loading={isSubmitting}>
          Trocar e-mail
        </Button>
      </form>
    </SettingsGroup>
  );
}

type OwnedGuild = { id: string; name: string };

function DeleteAccountCard({ me }: { me: View }) {
  const [open, setOpen] = useState(false);
  return (
    <SettingsGroup
      icon={Trash2}
      title="Excluir conta"
      description="Apaga sua conta, suas sessões e seus dados de perfil. Suas mensagens continuam nos canais, como “Usuário removido”. Não dá para desfazer."
    >
      <Button variant="destructive" className="self-start" onClick={() => setOpen(true)}>
        Excluir minha conta
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="sm" flush>
          {open ? <DeleteForm me={me} onClose={() => setOpen(false)} /> : null}
        </DialogContent>
      </Dialog>
    </SettingsGroup>
  );
}

function DeleteForm({ me, onClose }: { me: View; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const del = useDeleteMe();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string>();
  const [owned, setOwned] = useState<OwnedGuild[]>([]);
  const matches = username.trim().toLowerCase() === me.username;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!matches || !password) return;
    setPasswordError(undefined);
    setOwned([]);
    try {
      await del.mutateAsync({ data: { password } });
    } catch (err) {
      if (isApiError(err) && err.status === 422) setPasswordError("Senha incorreta.");
      else if (isApiError(err) && err.status === 409 && err.code === "owns_guilds")
        setOwned(((err.body.guilds as OwnedGuild[] | undefined) ?? []).slice(0, 50));
      else toast.error(messageFor(err));
      return;
    }
    await clearSessionToken();
    qc.clear();
    await navigate({ to: "/login" });
    toast.success("Conta excluída.");
  }

  return (
    <form onSubmit={(e) => void submit(e)} noValidate>
      <DialogHead
        icon={Trash2}
        title="Excluir conta"
        description="Esta ação é permanente. Confirme digitando seu nome de usuário e sua senha."
      />
      <DialogBody>
        {owned.length > 0 ? (
          <div role="alert" className="rounded-md border border-border bg-danger-soft p-3 text-sm">
            <p className="font-medium text-destructive-text">
              Você ainda é dono de {owned.length === 1 ? "um servidor" : "servidores"}. Transfira a
              posse ou exclua antes de excluir a conta:
            </p>
            <ul className="mt-2 list-disc pl-5">
              {owned.map((g) => (
                <li key={g.id}>{g.name}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <Field id="delete-username" label={`Digite ${me.username} para confirmar`}>
          <Input
            id="delete-username"
            autoComplete="off"
            autoCapitalize="none"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </Field>
        <Field id="delete-password" label="Senha" error={passwordError}>
          <Input
            id="delete-password"
            type="password"
            autoComplete="current-password"
            value={password}
            aria-invalid={!!passwordError}
            aria-describedby={describedBy("delete-password", passwordError)}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
      </DialogBody>
      <DialogActions>
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancelar
        </Button>
        <Button
          type="submit"
          variant="destructive"
          disabled={!matches || !password}
          loading={del.isPending}
        >
          Excluir conta
        </Button>
      </DialogActions>
    </form>
  );
}
