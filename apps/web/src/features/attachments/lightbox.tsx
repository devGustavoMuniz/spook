import * as Dialog from "@radix-ui/react-dialog";
import type { AttachmentPayload } from "@spook/shared";
import { ChevronLeft, ChevronRight, Download, X } from "lucide-react";
import { type RefObject, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/file-size";

/**
 * Visualizador de imagens (diálogo modal do Radix: foco preso, Esc fecha, foco volta ao gatilho).
 * Setas do teclado e botões navegam entre as imagens da mensagem.
 */
export function Lightbox({
  images,
  index,
  onIndexChange,
  onClose,
  returnFocusTo,
}: {
  images: readonly AttachmentPayload[];
  /** `null` = fechado. */
  index: number | null;
  onIndexChange: (i: number) => void;
  onClose: () => void;
  /** Elemento que recebe o foco ao fechar (o botão da miniatura clicada). */
  returnFocusTo?: RefObject<HTMLElement | null>;
}) {
  const open = index !== null;
  const current = index !== null ? images[index] : undefined;
  const count = images.length;
  const [failed, setFailed] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: nova imagem, novo estado de erro
  useEffect(() => setFailed(false), [index]);

  const go = (delta: number) => {
    if (index === null || count < 2) return;
    onIndexChange((index + delta + count) % count);
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/85" />
        <Dialog.Content
          aria-describedby={undefined}
          onCloseAutoFocus={(e) => {
            if (!returnFocusTo?.current) return;
            e.preventDefault();
            returnFocusTo.current.focus();
          }}
          className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 p-4 outline-none"
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") {
              e.preventDefault();
              go(-1);
            } else if (e.key === "ArrowRight") {
              e.preventDefault();
              go(1);
            }
          }}
          // Clique no fundo (fora da imagem e dos controles) fecha.
          onClick={(e) => e.target === e.currentTarget && onClose()}
        >
          <Dialog.Title className="sr-only">
            {current ? `Imagem ${current.filename}` : "Visualizador de imagens"}
          </Dialog.Title>
          {current ? (
            <>
              <div className="flex max-h-[80svh] max-w-full min-h-0 flex-1 items-center justify-center">
                {failed ? (
                  <p className="rounded-md bg-popover p-6 text-sm text-popover-foreground">
                    Não foi possível carregar a imagem. O link pode ter expirado: recarregue a
                    conversa.
                  </p>
                ) : (
                  <img
                    src={current.url}
                    alt={current.filename}
                    onError={() => setFailed(true)}
                    className="max-h-[80svh] max-w-full rounded object-contain"
                  />
                )}
              </div>
              <div className="flex items-center gap-3 rounded-md bg-popover/90 px-3 py-1.5 text-sm text-popover-foreground">
                <span className="max-w-[40ch] truncate" title={current.filename}>
                  {current.filename}
                </span>
                <span className="text-muted-foreground">{formatBytes(current.size)}</span>
                {count > 1 ? (
                  <span className="tabular-nums text-muted-foreground" aria-live="polite">
                    {(index ?? 0) + 1} / {count}
                  </span>
                ) : null}
                <Button asChild variant="ghost" size="icon" className="size-7">
                  <a
                    href={current.url}
                    download={current.filename}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Baixar ${current.filename}`}
                  >
                    <Download />
                  </a>
                </Button>
              </div>
            </>
          ) : null}
          {count > 1 ? (
            <>
              <Button
                variant="secondary"
                size="icon"
                className="absolute top-1/2 left-4 -translate-y-1/2 rounded-full"
                aria-label="Imagem anterior"
                onClick={() => go(-1)}
              >
                <ChevronLeft />
              </Button>
              <Button
                variant="secondary"
                size="icon"
                className="absolute top-1/2 right-4 -translate-y-1/2 rounded-full"
                aria-label="Próxima imagem"
                onClick={() => go(1)}
              >
                <ChevronRight />
              </Button>
            </>
          ) : null}
          <Dialog.Close asChild>
            <Button
              variant="secondary"
              size="icon"
              className="absolute top-4 right-4 rounded-full"
              aria-label="Fechar visualizador"
            >
              <X />
            </Button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
