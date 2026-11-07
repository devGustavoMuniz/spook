import {
  getListSessionsQueryKey,
  type SessionView,
  useGetLoginMethods,
  useListSessions,
  useRevokeOtherSessions,
  useRevokeSession,
  type View,
} from "@spook/shared";
import { useQueryClient } from "@tanstack/react-query";
import { MonitorSmartphone } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { socialStartUrl } from "@/auth/social-buttons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  isConfirmationCancelled,
  needsPasswordConfirmation,
  useConfirmPassword,
} from "@/features/account/confirm-password";
import { SettingsGroup } from "@/features/settings/ui";
import { dateFnsLocale, formatRelativeUnit, t, useT } from "@/i18n";
import { messageFor } from "@/lib/errors";

const PROVIDER_NAMES: Record<string, string> = { google: "Google", discord: "Discord" };

function deviceName(s: SessionView): string {
  if (s.browser && s.os) return t("settings.sessions.device", { browser: s.browser, os: s.os });
  return s.browser || s.os || t("settings.sessions.unknownDevice");
}

/** "há 3 horas" com a precisão que o servidor tem (o último uso é gravado no máximo 1 vez por hora). */
function lastSeen(iso: string, now = Date.now()): string {
  const min = Math.round((now - new Date(iso).getTime()) / 60_000);
  if (min < 60) return t("settings.sessions.justNow");
  if (min < 48 * 60) return formatRelativeUnit(-Math.round(min / 60), "hour");
  return formatRelativeUnit(-Math.round(min / 1440), "day");
}

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString(dateFnsLocale().code, { dateStyle: "medium" });

/**
 * Sessões ativas da conta: dispositivo aproximado (navegador e sistema), quando entrou e o último uso. Encerrar
 * uma ou todas as outras pede a senha confirmada há pouco (quem não tem senha confirma com o provedor).
 */
export function SessionsCard({ me }: { me: View }) {
  const { t } = useT();
  const qc = useQueryClient();
  const sessions = useListSessions();
  const methods = useGetLoginMethods({ query: { enabled: !me.has_password } });
  const revoke = useRevokeSession();
  const revokeOthers = useRevokeOtherSessions();
  const { run } = useConfirmPassword();
  const [needReauth, setNeedReauth] = useState(false);
  const list = sessions.data?.sessions ?? [];
  const others = list.filter((s) => !s.current).length;

  async function act(action: () => Promise<unknown>, success: string) {
    try {
      await run(action);
      setNeedReauth(false);
      await qc.invalidateQueries({ queryKey: getListSessionsQueryKey() });
      toast.success(success);
    } catch (e) {
      if (isConfirmationCancelled(e)) return;
      if (needsPasswordConfirmation(e)) setNeedReauth(true);
      else toast.error(messageFor(e));
    }
  }

  return (
    <SettingsGroup
      icon={MonitorSmartphone}
      title={t("settings.sessions.title")}
      description={t("settings.sessions.description")}
    >
      {sessions.isError ? (
        <p role="alert" className="text-sm text-destructive-text">
          {t("settings.sessions.loadFailed")}
        </p>
      ) : null}
      {needReauth ? (
        <div role="alert" className="rounded-md border border-border bg-accent p-3 text-sm">
          <p>{t("settings.sessions.reauthNotice")}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {(methods.data?.accounts ?? []).map((a) => (
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
      <ul
        className="flex flex-col divide-y divide-border"
        aria-label={t("settings.sessions.title")}
      >
        {list.map((s) => (
          <li key={s.id} className="flex items-center justify-between gap-3 py-2.5">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                {deviceName(s)}
                {s.current ? <Badge variant="brand">{t("settings.sessions.current")}</Badge> : null}
              </span>
              <span className="text-xs text-muted-foreground">
                {t("settings.sessions.signedIn", { date: formatDate(s.created_at) })} ·{" "}
                {t("settings.sessions.lastSeen", { when: lastSeen(s.last_seen_at) })} ·{" "}
                {s.remember ? t("settings.sessions.persistent") : t("settings.sessions.temporary")}
              </span>
            </div>
            {s.current ? null : (
              <Button
                variant="outline"
                size="sm"
                aria-label={t("settings.sessions.revokeAria", { device: deviceName(s) })}
                loading={revoke.isPending && revoke.variables?.id === s.id}
                onClick={() =>
                  void act(() => revoke.mutateAsync({ id: s.id }), t("settings.sessions.revoked"))
                }
              >
                {t("settings.sessions.revoke")}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {others > 0 ? (
        <Button
          variant="outline"
          className="self-start"
          loading={revokeOthers.isPending}
          onClick={() =>
            void act(() => revokeOthers.mutateAsync(), t("settings.sessions.revokedOthers"))
          }
        >
          {t("settings.sessions.revokeOthers")}
        </Button>
      ) : null}
    </SettingsGroup>
  );
}
