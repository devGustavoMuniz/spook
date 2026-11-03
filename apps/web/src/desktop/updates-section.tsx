import { Download, RefreshCw, RotateCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Hint, SettingsGroup } from "@/features/settings/ui";
import { dateFnsLocale, useT } from "@/i18n";
import { UpdateProgress } from "./update-progress";
import { updater as appUpdater, progressPercent, type Updater } from "./updater";

const formatTime = (at: number | Date) =>
  new Intl.DateTimeFormat(dateFnsLocale().code, { hour: "2-digit", minute: "2-digit" }).format(at);

/** `/settings/app` (só desktop): versão instalada, "Verificar atualizações", progresso e "Reiniciar para atualizar". */
export function UpdatesSection({ updater = appUpdater }: { updater?: Updater }) {
  const { t } = useT();
  const status = updater.useStore((s) => s.status);
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    updater
      .currentVersion()
      .then((v) => alive && setVersion(v))
      .catch(() => alive && setVersion(null));
    return () => {
      alive = false;
    };
  }, [updater]);

  const busy = status.kind === "checking" || status.kind === "downloading";
  return (
    <SettingsGroup
      icon={Download}
      title={t("settings.updates.title")}
      description={t("settings.updates.description")}
    >
      <p className="text-sm">
        {t("settings.updates.installed")}{" "}
        <strong className="font-semibold">
          {version ? `v${version}` : t("settings.updates.unknownVersion")}
        </strong>
      </p>
      <div aria-live="polite" className="flex flex-col gap-2 text-sm">
        {status.kind === "checking" ? <p>{t("settings.updates.checking")}</p> : null}
        {status.kind === "uptodate" ? (
          <p>{t("settings.updates.upToDate", { time: formatTime(new Date(status.checkedAt)) })}</p>
        ) : null}
        {status.kind === "available" ? (
          <p>{t("settings.updates.available", { version: status.version })}</p>
        ) : null}
        {status.kind === "downloading" ? (
          <>
            <p>
              {progressPercent(status.downloaded, status.total) === null
                ? t("settings.updates.downloadingUnknown", { version: status.version })
                : t("settings.updates.downloading", {
                    version: status.version,
                    percent: progressPercent(status.downloaded, status.total) ?? 0,
                  })}
            </p>
            <UpdateProgress downloaded={status.downloaded} total={status.total} />
          </>
        ) : null}
        {status.kind === "ready" ? (
          <p>{t("settings.updates.ready", { version: status.version })}</p>
        ) : null}
        {status.kind === "error" ? (
          <p role="alert" className="text-destructive-text">
            {status.message}
          </p>
        ) : null}
        {status.kind === "idle" ? <Hint>{t("settings.updates.idle")}</Hint> : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {status.kind === "ready" ? (
          <Button onClick={() => void updater.requestRestart()}>
            <RotateCw aria-hidden /> {t("settings.updates.restart")}
          </Button>
        ) : null}
        {status.kind === "error" && status.phase === "download" ? (
          <Button onClick={() => void updater.download()}>{t("settings.updates.retry")}</Button>
        ) : null}
        <Button
          variant="outline"
          onClick={() => void updater.check({ manual: true })}
          loading={status.kind === "checking"}
          disabled={busy || status.kind === "ready"}
        >
          <RefreshCw aria-hidden /> {t("settings.updates.check")}
        </Button>
      </div>
    </SettingsGroup>
  );
}
