import * as Dialog from "@radix-ui/react-dialog";
import type { AttachmentPayload } from "@spook/shared";
import { ChevronLeft, ChevronRight, Download, X, ZoomIn, ZoomOut } from "lucide-react";
import { type MouseEvent, type RefObject, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { formatBytes } from "@/lib/file-size";

const ZOOM = 2.4;

/**
 * Visualizador de imagens (diálogo modal do Radix: `aria-modal`, foco preso, Esc fecha, foco volta ao gatilho).
 * Setas do teclado e botões navegam entre as imagens; clicar na imagem (ou tocar duas vezes, no celular)
 * amplia a partir do ponto tocado e de novo reduz. Só `transform` e `opacity` animam.
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
  const [zoom, setZoom] = useState<{ x: number; y: number } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: nova imagem, novo estado de erro e de zoom
  useEffect(() => {
    setFailed(false);
    setZoom(null);
  }, [index]);

  const go = (delta: number) => {
    if (index === null || count < 2) return;
    onIndexChange((index + delta + count) % count);
  };

  function toggleZoom(e: MouseEvent<HTMLElement>) {
    if (zoom) return setZoom(null);
    const r = e.currentTarget.getBoundingClientRect();
    setZoom({
      x: r.width ? ((e.clientX - r.left) / r.width) * 100 : 50,
      y: r.height ? ((e.clientY - r.top) / r.height) * 100 : 50,
    });
  }

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[var(--z-modal)] bg-overlay data-[state=closed]:animate-overlay-out data-[state=open]:animate-overlay-in" />
        <Dialog.Content
          aria-describedby={undefined}
          onCloseAutoFocus={(e) => {
            if (!returnFocusTo?.current) return;
            e.preventDefault();
            returnFocusTo.current.focus();
          }}
          className="fixed inset-0 z-[var(--z-modal)] flex flex-col items-center justify-center gap-3 bg-overlay p-4 backdrop-blur-md outline-none data-[state=open]:animate-overlay-in"
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
              <div className="pointer-events-none flex max-h-[78svh] max-w-full min-h-0 flex-1 items-center justify-center overflow-hidden rounded-xl">
                {failed ? (
                  <p className="max-w-sm rounded-xl border bg-popover p-6 text-sm text-popover-foreground">
                    Não foi possível carregar a imagem. O link pode ter expirado: recarregue a
                    conversa.
                  </p>
                ) : (
                  // biome-ignore lint/a11y/useKeyWithClickEvents: o mesmo zoom tem botão com teclado ("Ampliar imagem")
                  <img
                    src={current.url}
                    alt={current.filename}
                    onError={() => setFailed(true)}
                    onClick={toggleZoom}
                    draggable={false}
                    style={{
                      transform: zoom ? `scale(${ZOOM})` : "scale(1)",
                      transformOrigin: zoom ? `${zoom.x}% ${zoom.y}%` : "50% 50%",
                    }}
                    className={`pointer-events-auto max-h-[78svh] max-w-full rounded-xl object-contain shadow-xl transition-transform duration-[var(--dur-slow)] ease-[var(--ease-out)] [touch-action:manipulation] ${zoom ? "cursor-zoom-out" : "cursor-zoom-in"}`}
                  />
                )}
              </div>
              <div className="flex max-w-full items-center gap-2 rounded-full border border-border bg-popover px-4 py-1.5 text-sm text-popover-foreground shadow-lg">
                <span className="max-w-[28ch] truncate font-medium" title={current.filename}>
                  {current.filename}
                </span>
                <span className="tabular text-xs text-muted-foreground">
                  {formatBytes(current.size)}
                </span>
                {count > 1 ? (
                  <span className="tabular text-xs text-muted-foreground" aria-live="polite">
                    {(index ?? 0) + 1} / {count}
                  </span>
                ) : null}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="size-8"
                  aria-label={zoom ? "Reduzir imagem" : "Ampliar imagem"}
                  aria-pressed={!!zoom}
                  onClick={() => setZoom(zoom ? null : { x: 50, y: 50 })}
                >
                  {zoom ? <ZoomOut /> : <ZoomIn />}
                </Button>
                <Button asChild variant="ghost" size="icon-sm" className="size-8">
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
                <span className="hidden items-center gap-1 text-xs text-muted-foreground md:flex">
                  <Kbd>Esc</Kbd> fecha
                </span>
              </div>
            </>
          ) : null}
          {count > 1 ? (
            <>
              <Button
                variant="secondary"
                size="icon-lg"
                className="absolute top-1/2 left-3 -translate-y-1/2 rounded-full shadow-lg"
                aria-label="Imagem anterior"
                onClick={() => go(-1)}
              >
                <ChevronLeft />
              </Button>
              <Button
                variant="secondary"
                size="icon-lg"
                className="absolute top-1/2 right-3 -translate-y-1/2 rounded-full shadow-lg"
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
              size="icon-lg"
              className="absolute top-3 right-3 rounded-full shadow-lg"
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
