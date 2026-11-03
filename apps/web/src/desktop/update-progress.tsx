import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import { progressPercent } from "./updater";

/** Barra de progresso do download (`role="progressbar"`); sem tamanho total fica indeterminada. */
export function UpdateProgress({
  downloaded,
  total,
  label,
  className,
}: {
  downloaded: number;
  total?: number;
  label?: string;
  className?: string;
}) {
  const { t } = useT();
  const pct = progressPercent(downloaded, total);
  return (
    <div
      role="progressbar"
      aria-label={label ?? t("settings.updates.progressLabel")}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct ?? undefined}
      aria-valuetext={pct === null ? t("settings.updates.downloadingShort") : `${pct}%`}
      className={cn("h-2 w-full overflow-hidden rounded-full bg-secondary", className)}
    >
      <div
        className={cn(
          "h-full rounded-full bg-primary transition-[width] duration-200 motion-reduce:transition-none",
          pct === null && "w-1/3 animate-shimmer motion-reduce:animate-none",
        )}
        style={pct === null ? undefined : { width: `${pct}%` }}
      />
    </div>
  );
}
