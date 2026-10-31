import { FileText, Loader2, RotateCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
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
  if (items.length === 0) return null;
  return (
    <ul aria-label="Anexos pendentes" className="flex flex-wrap gap-2 pb-1">
      {items.map((p) => (
        <li
          key={p.id}
          className={`flex w-56 items-start gap-2 rounded-md border p-2 text-xs ${
            p.status === "error" ? "border-destructive" : ""
          }`}
        >
          {p.previewUrl ? (
            <img src={p.previewUrl} alt="" className="size-10 shrink-0 rounded object-cover" />
          ) : (
            <span className="flex size-10 shrink-0 items-center justify-center rounded bg-secondary text-secondary-foreground">
              <FileText className="size-5" aria-hidden />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium text-sm" title={p.name}>
              {p.name}
            </p>
            <p className="text-muted-foreground">{formatBytes(p.size)}</p>
            {p.status === "uploading" ? (
              <div className="mt-1 flex items-center gap-1.5">
                <progress
                  value={p.progress}
                  max={100}
                  aria-label={`Enviando ${p.name}`}
                  className="h-1.5 min-w-0 flex-1 [&::-moz-progress-bar]:bg-primary [&::-webkit-progress-bar]:rounded [&::-webkit-progress-bar]:bg-secondary [&::-webkit-progress-value]:rounded [&::-webkit-progress-value]:bg-primary"
                />
                <span className="tabular-nums text-muted-foreground">{p.progress}%</span>
              </div>
            ) : p.status === "done" ? (
              <p className="text-emerald-600 dark:text-emerald-400">Pronto</p>
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
                aria-label={`Tentar enviar ${p.name} de novo`}
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
                p.status === "uploading" ? `Cancelar envio de ${p.name}` : `Remover ${p.name}`
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
