import { FileText, Loader2, RotateCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
import { formatBytes } from "@/lib/file-size";
import type { PendingFile } from "./upload-queue";

/** Anexos escolhidos e ainda não enviados: miniatura local, nome, tamanho, progresso e erro por arquivo. */
export function PendingAttachments({
  items,
  onRemove,
  onRetry,
}: {
  items: readonly PendingFile[];
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
}) {
  const { t } = useT();
  if (items.length === 0) return null;
  return (
    <ul
      aria-label={t("chat.pending.title")}
      className="flex flex-wrap gap-2 border-b border-border p-2"
    >
      {items.map((p) => (
        <li
          key={p.id}
          className={`flex w-60 max-w-full items-start gap-2 rounded-xl border bg-surface-1 p-2 text-xs ${
            p.status === "error" ? "border-destructive-text" : "border-border"
          }`}
        >
          {p.previewUrl ? (
            <img src={p.previewUrl} alt="" className="size-12 shrink-0 rounded-lg object-cover" />
          ) : (
            <span className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-accent text-brand-text">
              <FileText className="size-5" aria-hidden />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium text-sm" title={p.name}>
              {p.name}
            </p>
            <p className="tabular text-muted-foreground">{formatBytes(p.size)}</p>
            {p.status === "uploading" ? (
              <div className="mt-1 flex items-center gap-1.5">
                <progress
                  value={p.progress}
                  max={100}
                  aria-label={t("chat.pending.uploading", { name: p.name })}
                  className="h-1.5 min-w-0 flex-1 [&::-moz-progress-bar]:bg-primary [&::-webkit-progress-bar]:rounded [&::-webkit-progress-bar]:bg-secondary [&::-webkit-progress-value]:rounded [&::-webkit-progress-value]:bg-primary"
                />
                <span className="tabular-nums text-muted-foreground">{p.progress}%</span>
              </div>
            ) : p.status === "done" ? (
              <p className="text-success-text">{t("chat.pending.done")}</p>
            ) : (
              <p role="alert" className="text-destructive-text">
                {p.error}
              </p>
            )}
          </div>
          <div className="flex shrink-0 flex-col">
            {p.status === "error" ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6"
                aria-label={t("chat.pending.retry", { name: p.name })}
                onClick={() => onRetry(p.id)}
              >
                <RotateCw />
              </Button>
            ) : p.status === "uploading" && p.progress === 0 ? (
              <Loader2 className="m-1 size-4 animate-spin text-muted-foreground" aria-hidden />
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-6"
              aria-label={
                p.status === "uploading"
                  ? t("chat.pending.cancel", { name: p.name })
                  : t("chat.pending.remove", { name: p.name })
              }
              onClick={() => onRemove(p.id)}
            >
              <X />
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}
