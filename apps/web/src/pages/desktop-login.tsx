import { isApiError, useDesktopAuthorize, useGetMe } from "@spook/shared";
import { Link, useSearch } from "@tanstack/react-router";
import { CircleCheck, Laptop, LinkIcon } from "lucide-react";
import { useState } from "react";
import { StatusCard } from "@/auth/status-card";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
import { messageFor } from "@/lib/errors";
import { navigateTo } from "@/lib/navigate";

const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Login do app desktop pelo navegador: a pessoa (já logada, ou depois de entrar) confirma "Entrar no app do
 * computador"; o backend gera um código de uso único (60 s) e a página abre o deep link `spook://auth?code=`.
 */
export function DesktopLoginPage() {
  const { t } = useT();
  const { code_challenge: challenge } = useSearch({ strict: false }) as { code_challenge?: string };
  const { data: me } = useGetMe();
  const authorize = useDesktopAuthorize();
  const [link, setLink] = useState<string>();
  const [error, setError] = useState<string>();

  if (!challenge || !CHALLENGE.test(challenge))
    return (
      <StatusCard
        icon={LinkIcon}
        tone="danger"
        title={t("auth.reset.invalidTitle")}
        description={t("auth.desktop.invalidBody")}
        actions={
          <Button asChild variant="outline" size="lg">
            <Link to="/">{t("auth.desktop.goToSpook")}</Link>
          </Button>
        }
      />
    );

  if (link)
    return (
      <StatusCard
        icon={CircleCheck}
        tone="success"
        title={t("auth.desktop.readyTitle")}
        description={t("auth.desktop.readyBody")}
        actions={
          <Button asChild size="lg">
            <a href={link}>{t("auth.desktop.openApp")}</a>
          </Button>
        }
      />
    );

  async function confirm() {
    setError(undefined);
    try {
      const res = await authorize.mutateAsync({ data: { code_challenge: challenge as string } });
      setLink(res.redirect_url);
      navigateTo(res.redirect_url);
    } catch (e) {
      setError(
        isApiError(e) && e.status === 401 ? t("auth.desktop.sessionExpired") : messageFor(e),
      );
    }
  }

  return (
    <StatusCard
      icon={Laptop}
      title={t("auth.desktop.title")}
      description={
        me ? t("auth.desktop.asUser", { username: me.username }) : t("auth.desktop.confirm")
      }
      actions={
        <>
          <Button size="lg" loading={authorize.isPending} onClick={() => void confirm()}>
            {t("auth.desktop.title")}
          </Button>
          <Button asChild variant="ghost" size="lg">
            <Link to="/">{t("common.cancel")}</Link>
          </Button>
        </>
      }
    >
      {error ? (
        <p role="alert" className="text-sm text-destructive-text">
          {error}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">{t("auth.desktop.warning")}</p>
    </StatusCard>
  );
}
