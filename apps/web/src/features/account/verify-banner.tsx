import { isApiError, useAuthProviders, useGetMe, useResendVerificationEmail } from "@spook/shared";
import { MailWarning, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
import { messageFor } from "@/lib/errors";

const KEY = "spook:verify-banner-dismissed";

function dismissedBefore(): boolean {
  try {
    return sessionStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Faixa discreta "Verifique seu e-mail" para contas ainda não verificadas. Só aparece quando o servidor envia
 * e-mails (`email_enabled`); em modo degradado não há como verificar, então não incomoda. Fechar vale até
 * o fim da aba.
 */
export function VerifyEmailBanner() {
  const { t } = useT();
  const { data: me } = useGetMe();
  const { data: providers } = useAuthProviders({ query: { staleTime: 60_000 } });
  const resend = useResendVerificationEmail();
  const [hidden, setHidden] = useState(dismissedBefore);
  if (!me || me.email_verified || !providers?.email_enabled || hidden) return null;

  async function send() {
    try {
      await resend.mutateAsync();
      toast.success(t("auth.verifyBanner.resent"));
    } catch (e) {
      if (isApiError(e) && e.status === 409) toast.info(t("auth.verifyBanner.already"));
      else toast.error(messageFor(e));
    }
  }

  return (
    <output className="flex items-center gap-3 border-b border-border bg-accent px-4 py-2 text-sm">
      <MailWarning className="size-4 shrink-0 text-brand-text" aria-hidden="true" />
      <p className="min-w-0 flex-1 text-pretty">
        <strong className="font-semibold">{t("auth.verifyBanner.title")}</strong>{" "}
        <span className="text-muted-foreground">
          {t("auth.verifyBanner.body", { email: me.email })}
        </span>
      </p>
      <Button size="sm" variant="soft" loading={resend.isPending} onClick={() => void send()}>
        {t("auth.verifyBanner.resend")}
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={t("auth.verifyBanner.dismiss")}
        onClick={() => {
          try {
            sessionStorage.setItem(KEY, "1");
          } catch {
            // sem sessionStorage: o aviso some só até recarregar
          }
          setHidden(true);
        }}
      >
        <X aria-hidden="true" />
      </Button>
    </output>
  );
}
