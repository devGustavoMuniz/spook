import { Monitor } from "lucide-react";
import { useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { isTauri } from "@/desktop/runtime";
import {
  type AppSettings,
  getAppSettings,
  setAppSettings,
  shellErrorMessage,
} from "@/desktop/shell";
import { UpdatesSection } from "@/desktop/updates-section";
import { SettingsGroup } from "@/features/settings/ui";
import { type MessageKey, useT } from "@/i18n";

type Key = keyof AppSettings;

const OPTIONS: { key: Key; labelKey: MessageKey; hintKey: MessageKey }[] = [
  {
    key: "closeToTray",
    labelKey: "settings.app.closeToTray",
    hintKey: "settings.app.closeToTrayHint",
  },
  {
    key: "startWithSystem",
    labelKey: "settings.app.startWithSystem",
    hintKey: "settings.app.startWithSystemHint",
  },
  {
    key: "startMinimized",
    labelKey: "settings.app.startMinimized",
    hintKey: "settings.app.startMinimizedHint",
  },
];

/** `/settings/app`: opções do app para computador. Na web a página só explica que não se aplica. */
export function AppSettingsPage() {
  const { t } = useT();
  return isTauri() ? (
    <>
      <DesktopOptions />
      <UpdatesSection />
    </>
  ) : (
    <SettingsGroup
      icon={Monitor}
      title={t("settings.app.desktopOnly")}
      description={t("settings.app.desktopOnlyDescription")}
    />
  );
}

function DesktopOptions() {
  const { t } = useT();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    getAppSettings()
      .then((s) => alive && setSettings(s))
      .catch((e) => alive && setError(shellErrorMessage(e)));
    return () => {
      alive = false;
    };
  }, []);

  async function change(key: Key, value: boolean) {
    if (!settings || busy) return;
    setBusy(true);
    setError(null);
    try {
      setSettings(await setAppSettings({ ...settings, [key]: value }));
    } catch (e) {
      // O Rust não gravou: o interruptor continua no valor anterior.
      setError(shellErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsGroup
      icon={Monitor}
      title={t("settings.app.behavior")}
      description={t("settings.app.behaviorDescription")}
    >
      {OPTIONS.map(({ key, labelKey, hintKey }) => (
        <div key={key} className="flex items-center justify-between gap-4">
          <Label htmlFor={`app-${key}`} className="flex flex-col gap-1">
            {t(labelKey)}
            <span className="text-xs font-normal text-muted-foreground">{t(hintKey)}</span>
          </Label>
          <Switch
            id={`app-${key}`}
            checked={settings?.[key] ?? false}
            disabled={!settings || busy}
            onCheckedChange={(v) => void change(key, v)}
          />
        </div>
      ))}
      {error ? (
        <p role="alert" className="text-sm text-destructive-text">
          {error}
        </p>
      ) : null}
    </SettingsGroup>
  );
}
