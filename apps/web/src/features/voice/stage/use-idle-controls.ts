import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

export const AUTO_HIDE_MS = 3000;

/** Foco de teclado nestes elementos segura os controles visíveis. */
const HOLD_SELECTOR = "[role=toolbar], [data-idle-hold]";

export type IdleClock = {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
};
// Chama o setTimeout global a cada uso (relógios falsos do Vitest trocam a global depois do import).
const defaultClock: IdleClock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

/** Conta quem está segurando a barra visível (menu, diálogo). */
export const StageHoldContext = createContext<(held: boolean) => void>(() => {});

/** Enquanto `held` for verdadeiro, a barra de controles não some. */
export function useStageHold(held: boolean) {
  const hold = useContext(StageHoldContext);
  useEffect(() => {
    if (!held) return;
    hold(true);
    return () => hold(false);
  }, [held, hold]);
}

/**
 * Auto-ocultar dos controles do palco (`enabled` liga/desliga; `clock` permite relógio falso): aparecem com movimento do mouse e somem após `ms` de ociosidade.
 * Ficam visíveis com foco de teclado, menu/diálogo aberto, mouse sobre a barra e `forceVisible`.
 * Em toque (sem hover) o toque no palco alterna e não há temporizador.
 */
export function useIdleControls({
  ms = AUTO_HIDE_MS,
  forceVisible = false,
  enabled = true,
  clock = defaultClock,
}: {
  ms?: number;
  forceVisible?: boolean;
  /** Falso: os controles ficam sempre visíveis e não há temporizador. */
  enabled?: boolean;
  /** Relógio injetável (testes). */
  clock?: IdleClock;
} = {}) {
  const [shown, setShown] = useState(true);
  const holds = useRef(0);
  const overBar = useRef(false);
  const keyboardFocus = useRef(false);
  const touch = useRef(false);
  const timer = useRef<unknown>(undefined);
  const clockRef = useRef(clock);
  clockRef.current = clock;
  const shownRef = useRef(true);
  const [holdCount, setHoldCount] = useState(0);

  const set = useCallback((v: boolean) => {
    shownRef.current = v;
    setShown(v);
  }, []);
  const blocked = useCallback(
    () => holds.current > 0 || overBar.current || keyboardFocus.current,
    [],
  );
  const arm = useCallback(() => {
    clockRef.current.clearTimeout(timer.current);
    if (!enabled || touch.current || blocked()) return;
    timer.current = clockRef.current.setTimeout(() => {
      if (!blocked()) set(false);
    }, ms);
  }, [blocked, enabled, ms, set]);
  const wake = useCallback(() => {
    set(true);
    arm();
  }, [arm, set]);

  // Desligado, ou ligado de novo: começa visível e recomeça a contagem.
  useEffect(() => {
    set(true);
    arm();
    return () => clockRef.current.clearTimeout(timer.current);
  }, [arm, set]);

  // Tecla em qualquer lugar da página (o foco pode estar fora do palco) também acorda os controles.
  useEffect(() => {
    if (!enabled) return;
    window.addEventListener("keydown", wake, true);
    return () => window.removeEventListener("keydown", wake, true);
  }, [enabled, wake]);

  const hold = useCallback(
    (held: boolean) => {
      holds.current = Math.max(0, holds.current + (held ? 1 : -1));
      setHoldCount(holds.current);
      if (held) set(true);
      arm();
    },
    [arm, set],
  );

  const stageProps = {
    onPointerMove: (e: React.PointerEvent) => {
      touch.current = e.pointerType === "touch";
      if (!touch.current) wake();
    },
    onPointerDown: (e: React.PointerEvent) => {
      touch.current = e.pointerType === "touch";
    },
    onClick: (e: React.MouseEvent) => {
      // Toque no palco (fora de botões e da barra) alterna a barra; com mouse, só acorda.
      const el = e.target as HTMLElement;
      if (el.closest("button, a, input, [role=menu], [role=toolbar], [role=slider]")) return;
      if (touch.current) {
        const next = !shownRef.current;
        set(next);
        clockRef.current.clearTimeout(timer.current);
      } else wake();
    },
    onKeyDownCapture: () => wake(),
    onFocusCapture: (e: React.FocusEvent) => {
      const el = e.target as HTMLElement;
      try {
        keyboardFocus.current = el.matches(":focus-visible") && !!el.closest(HOLD_SELECTOR);
      } catch {
        keyboardFocus.current = false;
      }
      if (keyboardFocus.current) set(true);
      else if (!touch.current) wake();
    },
    onBlurCapture: (e: React.FocusEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) keyboardFocus.current = false;
      else if (!(e.relatedTarget as HTMLElement | null)?.closest(HOLD_SELECTOR))
        keyboardFocus.current = false;
      arm();
    },
  };
  const barProps = {
    onPointerEnter: (e: React.PointerEvent) => {
      if (e.pointerType === "touch") return;
      overBar.current = true;
      wake();
    },
    onPointerLeave: () => {
      overBar.current = false;
      arm();
    },
    /** Em toque, com a barra escondida o primeiro toque só a mostra (não aciona o botão). */
    onClickCapture: (e: React.MouseEvent) => {
      if (touch.current && !shownRef.current) {
        e.stopPropagation();
        e.preventDefault();
        set(true);
      }
    },
  };

  return {
    visible: !enabled || shown || forceVisible || holdCount > 0,
    stageProps,
    barProps,
    hold,
    held: holdCount > 0,
    idleEnabled: enabled,
  };
}
