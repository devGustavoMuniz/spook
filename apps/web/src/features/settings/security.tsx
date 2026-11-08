import { zodResolver } from "@hookform/resolvers/zod";
import {
  getGetLoginMethodsQueryKey,
  getGetMeQueryKey,
  isApiError,
  useAuthProviders,
  useChangeEmail,
  useChangePassword,
  useDeleteMe,
  useGetLoginMethods,
  useResendVerificationEmail,
  useSetInitialPassword,
  useUnlinkSocial,
  type View,
} from "@spook/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { KeyRound, Link2, Mail, MailCheck, MailWarning, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { socialStartUrl } from "@/auth/social-buttons";
import { socialErrorMessage } from "@/auth/social-errors";
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
import {
  isConfirmationCancelled,
  needsPasswordConfirmation,
  useConfirmPassword,
} from "@/features/account/confirm-password";
import { SessionsCard } from "@/features/settings/sessions";
import { SettingsGroup } from "@/features/settings/ui";
import { useSettingsNav } from "@/features/settings/use-settings";
import { useT } from "@/i18n";
import { messageFor } from "@/lib/errors";
import { navigateTo } from "@/lib/navigate";
import {
  type ChangeEmailForm,
  type ChangePasswordForm,
  changeEmailSchema,
  changePasswordSchema,
  type SetPasswordForm,
  setPasswordSchema,
} from "@/lib/schemas";

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Cartões de segurança da conta: trocar senha, trocar e-mail e excluir conta. */
export function SecuritySection({ me }: { me: View }) {
  return (
    <>
      {me.has_password ? <ChangePasswordCard /> : <SetPasswordCard />}
      <LoginMethodsCard me={me} />
      <SessionsCard me={me} />
      <ChangeEmailCard me={me} />
      <DeleteAccountCard me={me} />
    </>
  );
}

function ChangePasswordCard() {
  const { t } = useT();
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
      toast.success(t("settings.security.passwordChanged"));
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
      title={t("settings.security.password")}
      description={t("settings.security.passwordDescription")}
    >
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <Field
          id="current_password"
          label={t("settings.security.currentPassword")}
          error={errors.current_password?.message}
        >
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
          label={t("settings.security.newPassword")}
          hint={t("settings.security.passwordHint")}
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
              t("settings.security.passwordHint"),
            )}
            {...register("new_password")}
          />
        </Field>
        <Field
          id="confirm_password"
          label={t("settings.security.repeatNewPassword")}
          error={errors.confirm?.message}
        >
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
          {t("settings.security.changePassword")}
        </Button>
      </form>
    </SettingsGroup>
  );
}

function ChangeEmailCard({ me }: { me: View }) {
  const { t } = useT();
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
      setError("email", { message: t("settings.security.sameEmail") });
      return;
    }
    try {
      const res = await run(() => change.mutateAsync({ data: { email } }));
      qc.setQueryData(getGetMeQueryKey(), res);
      reset({ email: res.pending_email ? email : res.email });
      if (res.pending_email)
        toast.success(t("settings.security.emailConfirmationSent", { email: res.pending_email }));
      else toast.success(t("settings.security.emailChanged"));
    } catch (e) {
      if (isConfirmationCancelled(e)) return;
      if (isApiError(e) && (e.status === 409 || e.status === 422))
        setError("email", {
          message:
            e.status === 409
              ? t("settings.security.emailTaken")
              : t("settings.security.emailInvalid"),
        });
      else toast.error(messageFor(e));
    }
  });

  return (
    <SettingsGroup
      icon={Mail}
      title={t("settings.security.email")}
      description={t("settings.security.emailDescription")}
    >
      <VerificationStatus me={me} />
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <Field id="email" label={t("settings.security.email")} error={errors.email?.message}>
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
          {t("settings.security.changeEmail")}
        </Button>
      </form>
    </SettingsGroup>
  );
}

/** Estado da verificação do e-mail atual (e da troca pendente), com o reenvio. */
function VerificationStatus({ me }: { me: View }) {
  const { t } = useT();
  const { data: providers } = useAuthProviders({ query: { staleTime: 60_000 } });
  const resend = useResendVerificationEmail();
  const emailOn = providers?.email_enabled === true;

  async function send() {
    try {
      await resend.mutateAsync();
      toast.success(t("settings.security.newLinkSent"));
    } catch (e) {
      toast.error(messageFor(e));
    }
  }

  return (
    <div className="flex flex-col gap-2 text-sm">
      {me.email_verified ? (
        <p className="flex items-center gap-2 text-success-text" data-testid="email-status">
          <MailCheck className="size-4" aria-hidden="true" />
          {t("settings.security.emailVerified")}
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1" data-testid="email-status">
          <p className="flex items-center gap-2 text-muted-foreground">
            <MailWarning className="size-4" aria-hidden="true" />
            {t("settings.security.emailUnverified")}
          </p>
          {emailOn ? (
            <Button variant="link" size="sm" loading={resend.isPending} onClick={() => void send()}>
              {t("settings.security.resend")}
            </Button>
          ) : null}
        </div>
      )}
      {me.pending_email ? (
        <output className="block text-muted-foreground">
          {t("settings.security.pendingEmail", { pending: me.pending_email, email: me.email })}
        </output>
      ) : null}
    </div>
  );
}

const PROVIDER_NAMES: Record<string, string> = { google: "Google", discord: "Discord" };

/** Senha de contas criadas por login social (ainda sem senha): exige reautenticar com o provedor. */
function SetPasswordCard() {
  const { t } = useT();
  const qc = useQueryClient();
  const methods = useGetLoginMethods();
  const set = useSetInitialPassword();
  const [needReauth, setNeedReauth] = useState(false);
  const {
    register,
    handleSubmit,
    setError,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<SetPasswordForm>({
    resolver: zodResolver(setPasswordSchema),
    defaultValues: { new_password: "", confirm: "" },
  });
  const linked = methods.data?.accounts ?? [];

  const onSubmit = handleSubmit(async ({ new_password }) => {
    try {
      await set.mutateAsync({ data: { new_password } });
      reset();
      setNeedReauth(false);
      await qc.invalidateQueries({ queryKey: getGetMeQueryKey() });
      toast.success(t("settings.security.passwordSet"));
    } catch (e) {
      if (needsPasswordConfirmation(e)) setNeedReauth(true);
      else if (isApiError(e) && e.status === 422)
        setError("new_password", { message: t("settings.security.passwordLength") });
      else toast.error(messageFor(e));
    }
  });

  return (
    <SettingsGroup
      icon={KeyRound}
      title={t("settings.security.setPassword")}
      description={t("settings.security.setPasswordDescription")}
    >
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        {needReauth ? (
          <div role="alert" className="rounded-md border border-border bg-accent p-3 text-sm">
            <p>{t("settings.security.reauthNotice")}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {linked.map((a) => (
                <Button key={a.provider} asChild size="sm" variant="soft">
                  <a
                    href={socialStartUrl(a.provider, {
                      intent: "reauth",
                      redirect: "/settings/profile",
                    })}
                  >
                    {t("settings.security.confirmWith", {
                      provider: PROVIDER_NAMES[a.provider] ?? a.provider,
                    })}
                  </a>
                </Button>
              ))}
            </div>
          </div>
        ) : null}
        <Field
          id="initial_password"
          label={t("settings.security.newPassword")}
          hint={t("settings.security.passwordHint")}
          error={errors.new_password?.message}
        >
          <Input
            id="initial_password"
            type="password"
            autoComplete="new-password"
            aria-invalid={!!errors.new_password}
            aria-describedby={describedBy(
              "initial_password",
              errors.new_password?.message,
              t("settings.security.passwordHint"),
            )}
            {...register("new_password")}
          />
        </Field>
        <Field
          id="initial_confirm"
          label={t("settings.security.repeatPassword")}
          error={errors.confirm?.message}
        >
          <Input
            id="initial_confirm"
            type="password"
            autoComplete="new-password"
            aria-invalid={!!errors.confirm}
            aria-describedby={describedBy("initial_confirm", errors.confirm?.message)}
            {...register("confirm")}
          />
        </Field>
        <Button type="submit" className="self-start" loading={isSubmitting}>
          {t("settings.security.setPasswordButton")}
        </Button>
      </form>
    </SettingsGroup>
  );
}

/**
 * Contas vinculadas (Google/Discord). Vincular e desvincular pedem a senha confirmada há pouco; quem não tem
 * senha reautentica com o provedor. O último método de login nunca é removido (o servidor recusa com 409).
 */
function LoginMethodsCard({ me }: { me: View }) {
  const { t } = useT();
  const qc = useQueryClient();
  const settings = useSettingsNav();
  const search = useSearch({ strict: false }) as {
    linked?: string;
    reauth?: string;
    then?: string;
    social_error?: string;
  };
  const methods = useGetLoginMethods();
  const { data: providers } = useAuthProviders({ query: { staleTime: 60_000 } });
  const unlink = useUnlinkSocial();
  const { run, confirmNow } = useConfirmPassword();
  const linked = methods.data?.accounts ?? [];
  const enabled = providers?.providers ?? [];
  const names = Array.from(new Set([...enabled, ...linked.map((a) => a.provider)]));

  // Retorno do fluxo OAuth (?linked=, ?reauth=ok, ?social_error=): avisa e limpa a URL.
  // biome-ignore lint/correctness/useExhaustiveDependencies: roda uma vez por retorno
  useEffect(() => {
    if (!search.linked && !search.reauth && !search.social_error) return;
    if (search.linked) {
      toast.success(
        t("settings.security.linkedToast", {
          provider: PROVIDER_NAMES[search.linked] ?? search.linked,
        }),
      );
      void qc.invalidateQueries({ queryKey: getGetLoginMethodsQueryKey() });
    } else if (search.social_error) {
      toast.error(socialErrorMessage(search.social_error) ?? t("settings.security.socialFailed"));
    } else if (search.reauth === "ok") {
      const [action, provider] = (search.then ?? "").split(":");
      if (action === "link" && provider)
        navigateTo(socialStartUrl(provider, { intent: "link", redirect: "/settings/profile" }));
      else if (action === "unlink" && provider) void doUnlink(provider);
      else toast.success(t("settings.security.identityConfirmed"));
    }
    void settings.show("profile", ["linked", "reauth", "social_error", "then"]);
  }, [search.linked, search.reauth, search.social_error]);

  function reauth(provider: string, then: string) {
    navigateTo(
      socialStartUrl(provider, { intent: "reauth", redirect: `/settings/profile?then=${then}` }),
    );
  }

  async function doUnlink(provider: string) {
    try {
      if (me.has_password) await run(() => unlink.mutateAsync({ provider: provider as "google" }));
      else await unlink.mutateAsync({ provider: provider as "google" });
      await qc.invalidateQueries({ queryKey: getGetLoginMethodsQueryKey() });
      toast.success(
        t("settings.security.unlinkedToast", { provider: PROVIDER_NAMES[provider] ?? provider }),
      );
    } catch (e) {
      if (isConfirmationCancelled(e)) return;
      if (needsPasswordConfirmation(e)) reauth(provider, `unlink:${provider}`);
      else if (isApiError(e) && e.status === 409 && e.code === "last_login_method")
        toast.error(t("settings.security.lastMethod"));
      else toast.error(messageFor(e));
    }
  }

  async function link(provider: string) {
    if (me.has_password) {
      if (!(await confirmNow())) return;
      navigateTo(socialStartUrl(provider, { intent: "link", redirect: "/settings/profile" }));
    } else if (linked[0]) reauth(linked[0].provider, `link:${provider}`);
  }

  if (names.length === 0) return null;
  return (
    <SettingsGroup
      icon={Link2}
      title={t("settings.security.linkedAccounts")}
      description={t("settings.security.linkedAccountsDescription")}
    >
      <ul className="flex flex-col divide-y divide-border">
        {names.map((p) => {
          const acc = linked.find((a) => a.provider === p);
          return (
            <li key={p} className="flex items-center justify-between gap-3 py-2.5">
              <div className="flex min-w-0 flex-col">
                <span className="text-sm font-medium">{PROVIDER_NAMES[p] ?? p}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {acc
                    ? acc.email
                      ? t("settings.security.linkedWithEmail", { email: acc.email })
                      : t("settings.security.linked")
                    : t("settings.security.notLinked")}
                </span>
              </div>
              {acc ? (
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={t("settings.security.unlinkProvider", {
                    provider: PROVIDER_NAMES[p] ?? p,
                  })}
                  onClick={() => void doUnlink(p)}
                >
                  {t("settings.security.unlink")}
                </Button>
              ) : (
                <Button
                  variant="soft"
                  size="sm"
                  aria-label={t("settings.security.linkProvider", {
                    provider: PROVIDER_NAMES[p] ?? p,
                  })}
                  onClick={() => void link(p)}
                >
                  {t("settings.security.link")}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </SettingsGroup>
  );
}

type OwnedGuild = { id: string; name: string };

function DeleteAccountCard({ me }: { me: View }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  return (
    <SettingsGroup
      icon={Trash2}
      title={t("settings.security.deleteAccount")}
      description={t("settings.security.deleteDescription")}
    >
      <Button variant="destructive" className="self-start" onClick={() => setOpen(true)}>
        {t("settings.security.deleteMine")}
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
  const { t } = useT();
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
      if (isApiError(err) && err.status === 422)
        setPasswordError(t("settings.security.wrongPassword"));
      else if (isApiError(err) && err.status === 409 && err.code === "owns_guilds")
        setOwned(((err.body.guilds as OwnedGuild[] | undefined) ?? []).slice(0, 50));
      else toast.error(messageFor(err));
      return;
    }
    await clearSessionToken();
    qc.clear();
    await navigate({ to: "/login" });
    toast.success(t("settings.security.deleted"));
  }

  return (
    <form onSubmit={(e) => void submit(e)} noValidate>
      <DialogHead
        icon={Trash2}
        title={t("settings.security.deleteAccount")}
        description={t("settings.security.deleteConfirmDescription")}
      />
      <DialogBody>
        {owned.length > 0 ? (
          <div role="alert" className="rounded-md border border-border bg-danger-soft p-3 text-sm">
            <p className="font-medium text-destructive-text">
              {t("settings.security.ownsGuilds", { count: owned.length })}
            </p>
            <ul className="mt-2 list-disc pl-5">
              {owned.map((g) => (
                <li key={g.id}>{g.name}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <Field
          id="delete-username"
          label={t("settings.security.typeToConfirm", { username: me.username })}
        >
          <Input
            id="delete-username"
            autoComplete="off"
            autoCapitalize="none"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </Field>
        <Field
          id="delete-password"
          label={t("settings.security.passwordLabel")}
          error={passwordError}
        >
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
          {t("settings.security.cancel")}
        </Button>
        <Button
          type="submit"
          variant="destructive"
          disabled={!matches || !password}
          loading={del.isPending}
        >
          {t("settings.security.deleteAccount")}
        </Button>
      </DialogActions>
    </form>
  );
}
