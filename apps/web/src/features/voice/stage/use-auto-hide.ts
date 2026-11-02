import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

export const AUTO_HIDE_MS = 3000;

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
 * Auto-ocultar dos controles do palco: aparecem com movimento do mouse e somem após `ms` de ociosidade.
 * Ficam visíveis com foco de teclado, menu/diálogo aberto, mouse sobre a barra e `forceVisible`.
 * Em toque (sem hover) o toque no palco alterna e não há temporizador.
 */
export function useAutoHide({ ms = AUTO_HIDE_MS, forceVisible = false } = {}) {
  const [shown, setShown] = useState(true);
  const holds = useRef(0);
  const overBar = useRef(false);
  const keyboardFocus = useRef(false);
  const touch = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
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
    clearTimeout(timer.current);
    if (touch.current || blocked()) return;
    timer.current = setTimeout(() => {
      if (!blocked()) set(false);
    }, ms);
  }, [blocked, ms, set]);
  const wake = useCallback(() => {
    set(true);
    arm();
  }, [arm, set]);

  useEffect(() => {
    arm();
    return () => clearTimeout(timer.current);
  }, [arm]);

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
        clearTimeout(timer.current);
      } else wake();
    },
    onKeyDownCapture: () => wake(),
    onFocusCapture: (e: React.FocusEvent) => {
      const el = e.target as HTMLElement;
      try {
        keyboardFocus.current = el.matches(":focus-visible") && !!el.closest("[role=toolbar]");
      } catch {
        keyboardFocus.current = false;
      }
      if (keyboardFocus.current) set(true);
      else if (!touch.current) wake();
    },
    onBlurCapture: (e: React.FocusEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) keyboardFocus.current = false;
      else if (!(e.relatedTarget as HTMLElement | null)?.closest("[role=toolbar]"))
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
    visible: shown || forceVisible || holdCount > 0,
    stageProps,
    barProps,
    hold,
    held: holdCount > 0,
  };
}
