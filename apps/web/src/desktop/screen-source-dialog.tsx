// Diálogo "O que compartilhar?": grade de cartões com prévia (miniatura) de cada tela e janela, como o Discord.
// As telas/janelas vêm do Rust e as miniaturas chegam depois, uma a uma (skeleton até lá). Acessível: um
// `radiogroup` com tabulação por roving tabindex, setas movem a seleção, Enter/duplo clique confirmam.
import { AppWindow, ImageOff, Monitor } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import { PORTAL_SOURCE, type ScreenSource, subscribeScreenPicker } from "./screen-picker";
import {
  openScreenRecordingSettings,
  type ScreenThumbnail,
  startScreenThumbnails,
} from "./screen-thumbnails";

type Pending = { sources: ScreenSource[]; resolve: (id: string | null) => void };

export function ScreenSourceDialog() {
  const { t } = useT();
  const [pending, setPending] = useState<Pending | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, ScreenThumbnail>>({});
  const cardRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  useEffect(() => subscribeScreenPicker(setPending), []);

  const sources = pending?.sources;
  useEffect(() => {
    setChosen(sources?.[0]?.id ?? null);
    setThumbs({});
    if (!sources) return;
    // Cancela no Rust ao fechar (ou trocar a lista).
    return startScreenThumbnails(
      sources.filter((s) => s.id !== PORTAL_SOURCE).map((s) => s.id),
      (thumb) => setThumbs((prev) => ({ ...prev, [thumb.id]: thumb })),
    );
  }, [sources]);

  const screens = sources?.filter((s) => s.kind === "screen") ?? [];
  const windows = sources?.filter((s) => s.kind === "window") ?? [];
  const ordered = [...screens, ...windows];
  const permissionDenied = Object.values(thumbs).some((x) => x.error === "permission");

  const confirm = (id: string | null) => id && pending?.resolve(id);

  const move = (from: number, delta: number) => {
    const next = ordered[(from + delta + ordered.length) % ordered.length];
    if (!next) return;
    setChosen(next.id);
    cardRefs.current[next.id]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number, id: string) => {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      move(index, 1);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      move(index, -1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      confirm(id);
    } else if (e.key === " ") {
      e.preventDefault();
      setChosen(id);
    }
  };

  const card = (s: ScreenSource) => {
    const index = ordered.findIndex((o) => o.id === s.id);
    const selected = chosen === s.id;
    const thumb = thumbs[s.id];
    const Icon = s.kind === "screen" ? Monitor : AppWindow;
    const waiting = !thumb && s.id !== PORTAL_SOURCE;
    return (
      // biome-ignore lint/a11y/useSemanticElements: cartão com prévia; o radio nativo não aceita conteúdo rico
      <button
        key={s.id}
        ref={(el) => {
          cardRefs.current[s.id] = el;
        }}
        type="button"
        role="radio"
        aria-checked={selected}
        tabIndex={selected ? 0 : -1}
        onClick={() => setChosen(s.id)}
        onDoubleClick={() => confirm(s.id)}
        onKeyDown={(e) => onKeyDown(e, index, s.id)}
        className={cn(
          "group flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-card p-2 text-left text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          selected && "border-primary ring-2 ring-primary",
        )}
      >
        <span className="relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-md bg-muted">
          {thumb?.jpeg ? (
            <img
              src={`data:image/jpeg;base64,${thumb.jpeg}`}
              alt=""
              draggable={false}
              className="size-full object-contain"
            />
          ) : waiting ? (
            <Skeleton data-testid="thumb-skeleton" className="absolute inset-0 rounded-none" />
          ) : (
            <span className="flex flex-col items-center gap-1 text-muted-foreground">
              {s.id === PORTAL_SOURCE ? (
                <Icon className="size-8" aria-hidden="true" />
              ) : (
                <ImageOff className="size-6" aria-hidden="true" />
              )}
              {s.id === PORTAL_SOURCE ? null : (
                <span className="text-xs" aria-hidden="true">
                  {t("settings.screenPicker.noPreview")}
                </span>
              )}
            </span>
          )}
        </span>
        <span className="flex min-w-0 items-center gap-1.5">
          <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="truncate font-medium">{s.name}</span>
        </span>
      </button>
    );
  };

  const section = (title: string, list: ScreenSource[]) =>
    list.length === 0 ? null : (
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-muted-foreground">{title}</h3>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3">{list.map(card)}</div>
      </div>
    );

  const loading =
    !!sources && sources.some((s) => s.id !== PORTAL_SOURCE) && !Object.keys(thumbs).length;

  return (
    <Dialog open={!!pending} onOpenChange={(open) => !open && pending?.resolve(null)}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{t("settings.screenPicker.title")}</DialogTitle>
          <DialogDescription>{t("settings.screenPicker.description")}</DialogDescription>
        </DialogHeader>
        {permissionDenied ? (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted px-3 py-2 text-sm"
          >
            <span>{t("settings.screenPicker.permissionDenied")}</span>
            <Button variant="outline" size="sm" onClick={() => void openScreenRecordingSettings()}>
              {t("settings.screenPicker.openSettings")}
            </Button>
          </div>
        ) : null}
        {loading ? <span className="sr-only">{t("settings.screenPicker.loading")}</span> : null}
        <div
          role="radiogroup"
          aria-label={t("settings.screenPicker.title")}
          className="flex max-h-[60svh] flex-col gap-4 overflow-y-auto p-1"
        >
          {section(t("settings.screenPicker.screens"), screens)}
          {section(t("settings.screenPicker.windows"), windows)}
          {sources && sources.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("settings.screenPicker.none")}</p>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">{t("settings.screenPicker.privacy")}</p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => pending?.resolve(null)}>
            {t("settings.screenPicker.cancel")}
          </Button>
          <Button disabled={!chosen} onClick={() => confirm(chosen)}>
            {t("settings.screenPicker.share")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
