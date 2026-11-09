import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Crop, RotateCcw, X, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { DialogActions, DialogBody, DialogHead, overlayClass } from "@/components/ui/dialog";
import { Slider } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import { useT } from "@/i18n";
import {
  ASPECT,
  type CropKind,
  type CropView,
  coversImage,
  cropRect,
  INITIAL_VIEW,
  imageStyle,
  integerRect,
  MAX_ZOOM,
  MIN_ZOOM,
  panBy,
  type Rect,
  sniffAnimated,
  zoomTo,
} from "@/lib/crop";
import { cn } from "@/lib/utils";

/**
 * Resultado do recorte:
 * - `file`: estático já recortado (canvas) ou animado que segue como está (WebP/APNG animados);
 * - `gif`: o GIF original e o retângulo em pixels dele, que o servidor aplica a todos os quadros
 *   (`rect: null` = cobre a imagem toda, nada a recortar).
 */
export type CropResult =
  | { mode: "file"; file: File }
  | { mode: "gif"; file: File; rect: Rect | null };

type Mode = "static" | "gif" | "as-is";

const KEY_STEP = 0.05;
const KEY_STEP_BIG = 0.2;
const ZOOM_STEP = 0.25;

/** Moldura em % para uma `<img>` mostrando só o retângulo da vista. */
function Thumb({
  src,
  dims,
  rect,
  className,
  style,
  testId,
}: {
  src: string;
  dims: { w: number; h: number };
  rect: Rect;
  className?: string;
  style?: React.CSSProperties;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      aria-hidden
      className={cn("relative shrink-0 overflow-hidden bg-secondary", className)}
      style={style}
    >
      <img src={src} alt="" draggable={false} style={imageStyle(rect, dims.w, dims.h)} />
    </div>
  );
}

function CropperBody({
  file,
  kind,
  onCancel,
  onApply,
}: {
  file: File;
  kind: CropKind;
  onCancel: () => void;
  onApply: (r: CropResult) => void;
}) {
  const { t } = useT();
  const aspect = ASPECT[kind];
  const src = useMemo(() => URL.createObjectURL(file), [file]);
  useEffect(() => () => URL.revokeObjectURL(src), [src]);

  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [mode, setMode] = useState<Mode>(file.type === "image/gif" ? "gif" : "static");
  const [view, setView] = useState<CropView>(INITIAL_VIEW);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const frame = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<number | null>(null);

  // WebP/PNG animados: o canvas perderia a animação, então não há recorte (usa o arquivo como está).
  useEffect(() => {
    if (file.type === "image/gif") return;
    let alive = true;
    (async () => {
      try {
        const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
        if (alive && sniffAnimated(file.type, head)) setMode("as-is");
      } catch {
        // Sem leitura do cabeçalho, segue como estático (o canvas só perde uma animação rara).
      }
    })();
    return () => {
      alive = false;
    };
  }, [file]);

  const rect = dims ? cropRect(dims.w, dims.h, aspect, view) : null;
  const locked = mode === "as-is";
  const ready = !!dims && !!rect;

  const pan = useCallback(
    (dx: number, dy: number) => {
      if (dims && !locked) setView((v) => panBy(dims.w, dims.h, aspect, v, dx, dy));
    },
    [dims, aspect, locked],
  );
  const zoom = useCallback(
    (z: number, fx = 0.5, fy = 0.5) => {
      if (dims && !locked) setView((v) => zoomTo(dims.w, dims.h, aspect, v, z, fx, fy));
    },
    [dims, aspect, locked],
  );

  // Roda do mouse (ouvinte nativo: o React registra `wheel` como passivo e não deixaria impedir a rolagem).
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const viewRef = useRef(view);
  viewRef.current = view;
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const b = el.getBoundingClientRect();
      const fx = b.width > 0 ? (e.clientX - b.left) / b.width : 0.5;
      const fy = b.height > 0 ? (e.clientY - b.top) / b.height : 0.5;
      zoomRef.current(viewRef.current.zoom * Math.exp(-e.deltaY * 0.0015), fx, fy);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (locked) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()] as [
        { x: number; y: number },
        { x: number; y: number },
      ];
      pinch.current = Math.hypot(a.x - b.x, a.y - b.y);
    }
  }
  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const b = e.currentTarget.getBoundingClientRect();
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2 && pinch.current) {
      const [p, q] = [...pointers.current.values()] as [
        { x: number; y: number },
        { x: number; y: number },
      ];
      const d = Math.hypot(p.x - q.x, p.y - q.y);
      if (d > 0) {
        zoom(viewRef.current.zoom * (d / pinch.current));
        pinch.current = d;
      }
      return;
    }
    if (b.width > 0 && b.height > 0)
      pan((e.clientX - prev.x) / b.width, (e.clientY - prev.y) / b.height);
  }
  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const step = e.shiftKey ? KEY_STEP_BIG : KEY_STEP;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const mv = moves[e.key];
    if (mv) {
      e.preventDefault();
      pan(mv[0], mv[1]);
    } else if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      zoom(view.zoom + ZOOM_STEP);
    } else if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      zoom(view.zoom - ZOOM_STEP);
    }
  }

  async function apply() {
    if (!dims || !rect) return;
    if (mode === "as-is") return onApply({ mode: "file", file });
    if (mode === "gif") {
      const whole = coversImage(rect, dims.w, dims.h);
      return onApply({ mode: "gif", file, rect: whole ? null : integerRect(rect, dims.w, dims.h) });
    }
    setBusy(true);
    setFailed(false);
    try {
      const { renderCrop } = await import("@/lib/crop-image");
      onApply({ mode: "file", file: await renderCrop(file, rect, kind) });
    } catch {
      setFailed(true);
      setBusy(false);
    }
  }

  const title = t(`crop.title.${kind}` as const);
  const zoomLabel = t("crop.zoom");
  const maskClass =
    kind === "avatar" ? "rounded-full" : kind === "icon" ? "rounded-[20%]" : "rounded-none";

  return (
    <>
      <DialogHead icon={Crop} title={title} description={t("crop.description")} />
      <DialogBody>
        <div className="flex flex-col items-center gap-2">
          <div
            ref={frame}
            role="application"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: a moldura é o controle (setas e +/- operam nela)
            tabIndex={0}
            data-testid="crop-frame"
            aria-label={t("crop.frameLabel")}
            aria-describedby="crop-keys"
            onKeyDown={onKeyDown}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            style={{ aspectRatio: String(aspect), touchAction: "none" }}
            className={cn(
              "relative w-full select-none overflow-hidden rounded-lg border border-border bg-secondary outline-none focus-visible:ring-2 focus-visible:ring-ring",
              kind === "banner" ? "max-w-xl" : "max-w-72",
              locked ? "cursor-default" : "cursor-grab active:cursor-grabbing",
            )}
          >
            {ready ? (
              <img
                src={src}
                alt=""
                draggable={false}
                data-testid="crop-image"
                style={imageStyle(rect, dims.w, dims.h)}
              />
            ) : null}
            <img
              src={src}
              alt=""
              className="sr-only"
              onLoad={(e) =>
                setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
              }
              onError={() => setLoadError(true)}
            />
            {kind !== "banner" ? (
              <div
                aria-hidden
                className={cn(
                  "pointer-events-none absolute inset-0 shadow-[0_0_0_999px_rgb(0_0_0/0.55)] ring-2 ring-white/70",
                  maskClass,
                )}
              />
            ) : null}
            {!ready && !loadError ? (
              <div className="absolute inset-0 flex items-center justify-center">
                <Spinner />
              </div>
            ) : null}
          </div>
          <p id="crop-keys" className="text-center text-xs text-muted-foreground">
            {t("crop.keys")}
          </p>
        </div>

        {loadError ? (
          <p role="alert" className="text-sm text-destructive-text">
            {t("crop.loadFailed")}
          </p>
        ) : null}
        {failed ? (
          <p role="alert" className="text-sm text-destructive-text">
            {t("crop.failed")}
          </p>
        ) : null}
        {locked ? (
          <output className="block rounded-md bg-accent px-3 py-2 text-sm">
            {t("crop.animatedAsIs")}
          </output>
        ) : null}
        {mode === "gif" ? (
          <p className="text-xs text-muted-foreground">{t("crop.gifNote")}</p>
        ) : null}

        <div className="flex items-center gap-3">
          <ZoomOut className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <Slider
            aria-label={zoomLabel}
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            step={0.01}
            value={[view.zoom]}
            disabled={!ready || locked}
            onValueChange={([z]) => zoom(z ?? MIN_ZOOM)}
          />
          <ZoomIn className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("crop.reset")}
            title={t("crop.reset")}
            disabled={!ready || locked}
            onClick={() => setView(INITIAL_VIEW)}
          >
            <RotateCcw />
          </Button>
        </div>

        {ready ? (
          <section aria-label={t("crop.preview")} className="flex flex-col gap-2">
            <h3 className="text-xs font-medium text-muted-foreground">{t("crop.preview")}</h3>
            <div className="flex flex-wrap items-end gap-4">
              {kind === "banner" ? (
                <Thumb
                  testId="crop-preview"
                  src={src}
                  dims={dims}
                  rect={rect}
                  className="w-full max-w-80 rounded-lg border border-border"
                  style={{ aspectRatio: "4 / 1" }}
                />
              ) : (
                [80, 40, 28].map((size) => (
                  <Thumb
                    key={size}
                    testId={size === 80 ? "crop-preview" : undefined}
                    src={src}
                    dims={dims}
                    rect={rect}
                    className={cn(maskClass, "border border-border")}
                    style={{ width: size, height: size }}
                  />
                ))
              )}
            </div>
          </section>
        ) : null}
      </DialogBody>
      <DialogActions>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          {t("common.cancel")}
        </Button>
        <Button type="button" onClick={() => void apply()} disabled={!ready || busy} loading={busy}>
          {t("crop.apply")}
        </Button>
      </DialogActions>
    </>
  );
}

/**
 * Diálogo de recorte (avatar, ícone de servidor, banner). Abre quando `file` não é nulo. Esc ou Cancelar
 * chamam `onCancel`; Aplicar chama `onApply` com o resultado (quem chama fecha o diálogo e envia).
 */
export function ImageCropDialog({
  file,
  kind,
  onCancel,
  onApply,
}: {
  file: File | null;
  kind: CropKind;
  onCancel: () => void;
  onApply: (r: CropResult) => void;
}) {
  const { t } = useT();
  return (
    <DialogPrimitive.Root open={file !== null} onOpenChange={(o) => !o && onCancel()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={overlayClass} />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          data-testid="crop-dialog"
          className="fixed inset-0 z-[var(--z-modal)] m-auto flex h-dvh w-full flex-col overflow-hidden border-border bg-popover pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-popover-foreground shadow-xl outline-none data-[state=closed]:animate-dialog-out data-[state=open]:animate-dialog-in sm:h-auto sm:max-h-[90svh] sm:max-w-xl sm:rounded-xl sm:border sm:pt-0 sm:pb-0"
        >
          {file ? (
            <CropperBody
              key={`${file.name}:${file.size}:${file.lastModified}`}
              file={file}
              kind={kind}
              onCancel={onCancel}
              onApply={onApply}
            />
          ) : null}
          <DialogPrimitive.Close
            aria-label={t("common.close")}
            className="absolute top-3.5 right-3.5 z-10 inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" />
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
