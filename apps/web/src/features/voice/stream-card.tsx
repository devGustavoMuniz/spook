import type { VoiceStatePayload } from "@spook/shared";
import { MonitorUp } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { loadViewStreamPreviews } from "./devices";
import { useStreamPreview } from "./screen-preview";

/** Atraso para abrir ao passar o mouse (evita abrir ao atravessar a lista) e para fechar ao sair. */
export const CARD_OPEN_DELAY_MS = 250;
export const CARD_CLOSE_DELAY_MS = 150;
const FOCUS_CLICK_GRACE_MS = 400;
const CARD_WIDTH = 256;
const GAP = 8;

/** Como assistir uma transmissão: o que o item da lista precisa para entrar no canal e pedir o foco. */
export type WatchAction = {
  /** Entra (se preciso) e põe a tela dele em foco. */
  onWatch: (userId: string) => void;
  /** Sem permissão para entrar no canal de voz (e eu ainda não estou nele). */
  canConnect: boolean;
};

/**
 * Cartão da transmissão (hover card, sem biblioteca): miniatura da prévia, "Tela de {nome}", "Ao vivo" e o botão
 * "Assistir transmissão". Abre com atraso ao passar o mouse sobre o nome ou o ícone de tela, ao focar o ícone pelo
 * teclado ou ao tocar/clicar nele; fecha ao sair, com Esc ou ao rolar. Fica num portal (a lista de canais rola e
 * corta) e, abrindo por teclado, o Tab seguinte leva ao botão.
 */
export function StreamCard({
  state,
  name,
  watch,
  children,
  className,
}: {
  state: VoiceStatePayload;
  name: string;
  watch: WatchAction;
  /** O nome (e o resto da linha que também abre o cartão). */
  children: React.ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const watchBtn = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const skipFocusOpen = useRef(false);
  const focusOpenedAt = useRef(0);
  const cardId = useId();

  const clear = () => clearTimeout(timer.current);
  const schedule = (next: boolean, delay: number) => {
    clear();
    timer.current = setTimeout(() => setOpen(next), delay);
  };
  const close = useCallback((refocus = false) => {
    clearTimeout(timer.current);
    setOpen(false);
    if (refocus) {
      skipFocusOpen.current = true;
      trigger.current?.focus();
    }
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);

  // Posição: ao lado do item (à direita; à esquerda se não couber), dentro da janela.
  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const r = anchor.current.getBoundingClientRect();
    const spaceRight = window.innerWidth - r.right;
    const left =
      spaceRight >= CARD_WIDTH + GAP
        ? r.right + GAP
        : r.left - CARD_WIDTH - GAP >= 0
          ? r.left - CARD_WIDTH - GAP
          : Math.max(GAP, Math.min(r.left, window.innerWidth - CARD_WIDTH - GAP));
    setPos({ left, top: Math.max(GAP, Math.min(r.top - 4, window.innerHeight - 280)) });
  }, [open]);

  // Esc fecha (de onde estiver o foco); rolar ou redimensionar também, pois o cartão é fixo na janela.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(true);
    };
    const away = () => close();
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", away, true);
    window.addEventListener("resize", away);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", away, true);
      window.removeEventListener("resize", away);
    };
  }, [open, close]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: o hover é um atalho; o botão do ícone cobre teclado e toque
    <span
      ref={anchor}
      className={cn("flex min-w-0 flex-1 items-center gap-2", className)}
      onMouseEnter={() => schedule(true, CARD_OPEN_DELAY_MS)}
      onMouseLeave={() => schedule(false, CARD_CLOSE_DELAY_MS)}
    >
      {children}
      <button
        ref={trigger}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? cardId : undefined}
        aria-label={`Ver a transmissão de ${name}`}
        className="inline-flex shrink-0 rounded-sm p-0.5 text-primary outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        onFocus={() => {
          if (skipFocusOpen.current) {
            skipFocusOpen.current = false;
            return;
          }
          clear();
          focusOpenedAt.current = Date.now();
          setOpen(true);
        }}
        onClick={() => {
          clear();
          // Clicar com o mouse foca (e abre) e em seguida dispara o clique: este não deve fechar o que acabou de abrir.
          if (Date.now() - focusOpenedAt.current < FOCUS_CLICK_GRACE_MS) return;
          setOpen((o) => !o);
        }}
        onKeyDown={(e) => {
          // O cartão fica num portal: Tab (ou seta para a direita) leva direto ao botão dele.
          const btn = watchBtn.current;
          if (
            open &&
            btn &&
            !btn.disabled &&
            !e.shiftKey &&
            (e.key === "Tab" || e.key === "ArrowRight")
          ) {
            e.preventDefault();
            btn.focus();
          }
        }}
      >
        <MonitorUp className="size-3.5" role="img" aria-label="Compartilhando a tela" />
      </button>
      {open && pos
        ? createPortal(
            <div
              ref={card}
              id={cardId}
              role="dialog"
              aria-label={`Transmissão de ${name}`}
              style={{ top: pos.top, left: pos.left, width: CARD_WIDTH }}
              className="fixed z-[var(--z-popover)] flex origin-left animate-pop-in flex-col gap-2 rounded-lg border border-border bg-popover p-2 text-popover-foreground shadow-lg"
              onMouseEnter={clear}
              onMouseLeave={() => schedule(false, CARD_CLOSE_DELAY_MS)}
              onKeyDown={(e) => {
                if (e.key === "Tab") {
                  e.preventDefault();
                  close(true);
                }
              }}
            >
              <StreamCardBody
                state={state}
                name={name}
                watch={watch}
                watchRef={watchBtn}
                onWatched={() => close()}
              />
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}

function StreamCardBody({
  state,
  name,
  watch,
  watchRef,
  onWatched,
}: {
  state: VoiceStatePayload;
  name: string;
  watch: WatchAction;
  watchRef: React.RefObject<HTMLButtonElement | null>;
  onWatched: () => void;
}) {
  // Lida na hora de abrir: a opção "Mostrar prévias das transmissões" vale para o próximo cartão.
  const [viewPreviews] = useState(loadViewStreamPreviews);
  const wantsImage = viewPreviews && state.screen_preview && state.channel_id !== null;
  const preview = useStreamPreview(state.channel_id ?? "", state.user_id, wantsImage);
  const reasonId = useId();

  return (
    <>
      {wantsImage && preview.status === "loading" ? (
        <Skeleton className="aspect-video w-full" />
      ) : preview.status === "ready" ? (
        <img
          src={preview.url}
          alt={`Prévia da tela de ${name}`}
          width={320}
          height={180}
          className="aspect-video w-full rounded-md bg-black object-contain"
        />
      ) : (
        <div className="flex aspect-video w-full items-center justify-center rounded-md bg-muted text-muted-foreground">
          <MonitorUp className="size-8" aria-hidden />
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-sm font-medium">Tela de {name}</p>
        <Badge variant="destructive" className="shrink-0">
          Ao vivo
        </Badge>
      </div>
      <Button
        ref={watchRef}
        size="sm"
        disabled={!watch.canConnect}
        aria-describedby={watch.canConnect ? undefined : reasonId}
        onClick={() => {
          watch.onWatch(state.user_id);
          onWatched();
        }}
      >
        Assistir transmissão<span className="sr-only"> de {name}</span>
      </Button>
      {watch.canConnect ? null : (
        <p id={reasonId} className="text-xs text-muted-foreground">
          Você não tem permissão para entrar neste canal de voz.
        </p>
      )}
    </>
  );
}
