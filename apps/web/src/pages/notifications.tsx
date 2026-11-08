import { Bell, BellOff, BellRing, MessageSquareDot, MonitorSmartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { isTauri } from "@/desktop/runtime";
import { useNotificationPrefs } from "@/features/notifications/prefs";
import { NotificationDefaultsCard } from "@/features/notifications/settings-card";
import type { PushStatus } from "@/features/push/push";
import { usePushSettings } from "@/features/push/use-push";
import { SettingRow, SettingsGroup } from "@/features/settings/ui";
import { SettingsLink } from "@/features/settings/use-settings";
import { type MessageKey, useT } from "@/i18n";

/** `/settings/notifications`: silenciar avisos in-app e ativar o push neste dispositivo. */
export function NotificationsPage() {
  return (
    <div className="flex flex-col gap-6">
      <InAppCard />
      <NotificationDefaultsCard />
      {isTauri() ? <NativeCard /> : <PushCard />}
    </div>
  );
}

function InAppCard() {
  const { t } = useT();
  const muted = useNotificationPrefs((s) => s.muted);
  const setMuted = useNotificationPrefs((s) => s.setMuted);
  return (
    <SettingsGroup
      icon={MessageSquareDot}
      title={t("shell.notifications.inAppTitle")}
      description={t("shell.notifications.inAppDesc")}
    >
      <SettingRow
        htmlFor="mute-notifications"
        label={t("shell.notifications.mute")}
        hint={t("shell.notifications.muteHint")}
      >
        <Switch id="mute-notifications" checked={muted} onCheckedChange={setMuted} />
      </SettingRow>
    </SettingsGroup>
  );
}

/** No app desktop não há Web Push: os avisos saem como notificações nativas do sistema. */
function NativeCard() {
  const { t } = useT();
  return (
    <SettingsGroup
      icon={MonitorSmartphone}
      title={t("shell.notifications.nativeTitle")}
      description={t("shell.notifications.nativeDesc")}
    >
      <Button asChild variant="outline" size="sm" className="self-start">
        <SettingsLink section="app">{t("shell.notifications.trayLink")}</SettingsLink>
      </Button>
    </SettingsGroup>
  );
}

const STATUS_KEY = {
  checking: "shell.notifications.status.checking",
  unsupported: "shell.notifications.status.unsupported",
  "needs-install": "shell.notifications.status.needsInstall",
  "server-off": "shell.notifications.status.serverOff",
  blocked: "shell.notifications.status.blocked",
  inactive: "shell.notifications.status.inactive",
  active: "shell.notifications.status.active",
} as const satisfies Record<PushStatus, MessageKey>;

function PushCard() {
  const { t } = useT();
  const { status, busy, error, enable, disable } = usePushSettings();
  return (
    <SettingsGroup
      icon={BellRing}
      title={t("shell.notifications.pushTitle")}
      description={t("shell.notifications.pushDesc")}
    >
      <output
        className="flex items-start gap-2 rounded-lg bg-surface-1 px-3 py-2.5 text-sm"
        data-status={status}
      >
        {status === "active" ? (
          <Bell className="mt-0.5 size-4 shrink-0 text-success-text" aria-hidden />
        ) : (
          <BellOff className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        )}
        <span>{t(STATUS_KEY[status])}</span>
      </output>
      <div className="flex gap-2">
        {status === "inactive" ? (
          <Button onClick={() => void enable()} loading={busy}>
            {t("shell.notifications.enable")}
          </Button>
        ) : null}
        {status === "active" ? (
          <Button variant="outline" onClick={() => void disable()} loading={busy}>
            {t("shell.notifications.disable")}
          </Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive-text">
          {error}
        </p>
      ) : null}
    </SettingsGroup>
  );
}
