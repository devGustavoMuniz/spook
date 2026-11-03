import {
  getGetMeQueryKey,
  isApiError,
  useGetMe,
  useResendVerificationEmail,
  useVerifyEmail,
} from "@spook/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { CircleCheck, LinkIcon, MailWarning, TimerOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { StatusCard } from "@/auth/status-card";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
import { translateDetail } from "@/lib/app-errors";
import { messageFor } from "@/lib/errors";

type Phase =
  | { kind: "loading" }
  | { kind: "verified"; email: string; changed: boolean }
  | { kind: "expired" }
  | { kind: "invalid" }
  | { kind: "error"; message: string };

/**
 * Link do e-mail (`/verify-email?token=`): confirma o endereço (cadastro) ou conclui a troca de e-mail.
 * O token sai da URL logo ao abrir e só trafega no corpo do POST. Funciona em outro navegador (sem sessão).
 */
export function VerifyEmailPage() {
  const { t } = useT();
  const { token: urlToken } = useSearch({ strict: false }) as { token?: string };
  const navigate = useNavigate();
  const qc = useQueryClient();
  const verify = useVerifyEmail();
  const token = useRef(urlToken);
  const started = useRef(false);
  const [phase, setPhase] = useState<Phase>(urlToken ? { kind: "loading" } : { kind: "invalid" });

  const run = useRef(async () => {});
  run.current = async () => {
    if (!token.current) return setPhase({ kind: "invalid" });
    setPhase({ kind: "loading" });
    try {
      const res = await verify.mutateAsync({ data: { token: token.current } });
      token.current = undefined;
      await qc.invalidateQueries({ queryKey: getGetMeQueryKey() });
      setPhase({ kind: "verified", email: res.email, changed: res.status === "changed" });
    } catch (e) {
      if (isApiError(e) && e.status === 410)
        setPhase({ kind: e.code === "token_expired" ? "expired" : "invalid" });
      else if (isApiError(e) && e.status === 409)
        setPhase({ kind: "error", message: translateDetail(e.detail) });
      else setPhase({ kind: "error", message: messageFor(e) });
    }
  };

  useEffect(() => {
    if (urlToken) void navigate({ to: "/verify-email", search: {}, replace: true });
    if (started.current) return;
    started.current = true;
    if (token.current) void run.current();
  }, [urlToken, navigate]);

  if (phase.kind === "loading")
    return (
      <StatusCard busy title={t("auth.verify.confirming")} description={t("auth.verify.moment")} />
    );
  if (phase.kind === "verified")
    return (
      <StatusCard
        icon={CircleCheck}
        tone="success"
        title={phase.changed ? t("auth.verify.changedTitle") : t("auth.verify.verifiedTitle")}
        description={
          phase.changed
            ? t("auth.verify.changedBody", { email: phase.email })
            : t("auth.verify.verifiedBody", { email: phase.email })
        }
        actions={
          <Button asChild size="lg">
            <Link to="/">{t("auth.verify.open")}</Link>
          </Button>
        }
      />
    );
  if (phase.kind === "error")
    return (
      <StatusCard
        icon={MailWarning}
        tone="danger"
        title={t("auth.verify.failTitle")}
        description={phase.message}
        actions={
          <Button size="lg" onClick={() => void run.current()}>
            {t("common.retry")}
          </Button>
        }
      />
    );
  return <ExpiredOrInvalid expired={phase.kind === "expired"} />;
}

function ExpiredOrInvalid({ expired }: { expired: boolean }) {
  const { t } = useT();
  const { data: me } = useGetMe({ query: { retry: false } });
  const resend = useResendVerificationEmail();
  return (
    <StatusCard
      icon={expired ? TimerOff : LinkIcon}
      tone="danger"
      title={expired ? t("auth.reset.expiredTitle") : t("auth.reset.invalidTitle")}
      description={expired ? t("auth.verify.expiredBody") : t("auth.verify.invalidBody")}
      actions={
        me ? (
          <Button
            size="lg"
            loading={resend.isPending}
            onClick={() =>
              void resend
                .mutateAsync()
                .then(() => toast.success(t("auth.verifyBanner.resent")))
                .catch((e) =>
                  toast.error(
                    isApiError(e) && e.status === 409
                      ? t("auth.verifyBanner.already")
                      : messageFor(e),
                  ),
                )
            }
          >
            {t("auth.verify.resendEmail")}
          </Button>
        ) : (
          <Button asChild size="lg">
            <Link to="/login">{t("auth.verify.signInToResend")}</Link>
          </Button>
        )
      }
    />
  );
}
