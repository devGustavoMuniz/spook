import { useRouterState } from "@tanstack/react-router";
import { Menu, Users } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Abaixo disto a navegação (servidores + canais/DMs) vira drawer pela esquerda (Tailwind `md`). */
export const NAV_COMPACT_QUERY = "(max-width: 767px)";
/** Abaixo disto o painel de membros vira sheet pela direita (Tailwind `lg`). */
export const SIDE_COMPACT_QUERY = "(max-width: 1023px)";

/** `matches` de uma media query; sem `matchMedia` (jsdom) devolve `false`, ou seja, layout de desktop. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (cb: () => void) => {
      if (typeof window.matchMedia !== "function") return () => {};
      const mql = window.matchMedia(query);
      mql.addEventListener("change", cb);
      return () => mql.removeEventListener("change", cb);
    },
    [query],
  );
  const get = () =>
    typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false;
  return useSyncExternalStore(subscribe, get, () => false);
}

type ShellState = {
  /** Largura estreita: navegação em drawer. */
  compact: boolean;
  navOpen: boolean;
  setNavOpen: (open: boolean) => void;
  /** Mantém o drawer aberto nas próximas navegações (ex.: ao escolher um servidor, para mostrar os canais dele). */
  holdNav: () => void;
  membersOpen: boolean;
  setMembersOpen: (open: boolean) => void;
  /** Elemento onde a lista lateral (canais/DMs) é montada quando `compact`. */
  navSlot: HTMLElement | null;
};

const ShellContext = createContext<ShellState | null>(null);

/** Estado do shell; `null` fora da área autenticada (os componentes degradam para o layout de desktop). */
export const useShell = () => useContext(ShellContext);

/**
 * Estado e ancoragens do shell responsivo da área autenticada. Quem monta o layout usa `NavDrawer`;
 * as telas usam `NavToggle`, `MembersToggle`, `ShellSidebar` e `SideSheet`.
 */
export function ShellProvider({
  children,
  navSlot,
}: {
  children: ReactNode;
  navSlot: HTMLElement | null;
}) {
  const compact = useMediaQuery(NAV_COMPACT_QUERY);
  const [navOpen, setNavOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const holdUntil = useRef(0);
  const holdNav = useCallback(() => {
    holdUntil.current = Date.now() + 1500;
  }, []);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // Fecha ao navegar (exceto logo após escolher um servidor) e ao sair da largura estreita.
  // biome-ignore lint/correctness/useExhaustiveDependencies: só a mudança de rota fecha
  useEffect(() => {
    if (Date.now() < holdUntil.current) return;
    setNavOpen(false);
    setMembersOpen(false);
  }, [pathname]);
  useEffect(() => {
    if (!compact) setNavOpen(false);
  }, [compact]);

  const value = useMemo<ShellState>(
    () => ({ compact, navOpen, setNavOpen, holdNav, membersOpen, setMembersOpen, navSlot }),
    [compact, navOpen, holdNav, membersOpen, navSlot],
  );
  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Painel modal que desliza pela lateral: fundo que fecha ao toque, Esc, foco preso e devolvido ao
 * gatilho, `aria-modal`. Só `transform` e `opacity` animam. Fechado fica `inert` (fora do Tab e da leitura).
 */
export function Drawer({
  open,
  onClose,
  side,
  label,
  className,
  children,
}: {
  open: boolean;
  onClose: () => void;
  side: "left" | "right";
  label: string;
  className?: string;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    // O foco vai para o próprio painel (Tab segue dali): focar o primeiro item acenderia a dica dele.
    panel.current?.focus();
    return () => {
      if (previous && document.contains(previous)) previous.focus();
    };
  }, [open]);

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    // Eventos de portais (menus, diálogos abertos de dentro do drawer) borbulham pela árvore do React.
    if (!panel.current?.contains(e.target as Node)) return;
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (el) => el.offsetParent !== null || el === document.activeElement,
    );
    if (items.length === 0) return;
    const firstEl = items[0] as HTMLElement;
    const lastEl = items[items.length - 1] as HTMLElement;
    if (e.shiftKey && document.activeElement === firstEl) {
      e.preventDefault();
      lastEl.focus();
    } else if (!e.shiftKey && document.activeElement === lastEl) {
      e.preventDefault();
      firstEl.focus();
    }
  }

  return (
    <>
      <div
        aria-hidden
        data-testid="drawer-backdrop"
        onClick={onClose}
        className={cn(
          "fixed inset-0 z-[var(--z-overlay)] bg-overlay transition-opacity duration-[var(--dur-slow)] ease-[var(--ease-out)]",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal={open || undefined}
        aria-label={label}
        tabIndex={-1}
        inert={!open}
        onKeyDown={onKeyDown}
        data-state={open ? "open" : "closed"}
        className={cn(
          "fixed inset-y-0 z-[var(--z-overlay)] flex max-w-[90vw] flex-col bg-sidebar pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] outline-none transition-transform duration-[var(--dur-slow)] ease-[var(--ease-out)]",
          side === "left"
            ? "left-0 pl-[env(safe-area-inset-left)]"
            : "right-0 pr-[env(safe-area-inset-right)]",
          open
            ? "translate-x-0 shadow-xl"
            : side === "left"
              ? "-translate-x-full"
              : "translate-x-full",
          className,
        )}
      >
        {children}
      </div>
    </>
  );
}

/** Drawer de navegação da esquerda: contém a barra de servidores e o `navSlot` da lista de canais/DMs. */
export function NavDrawer({
  rail,
  onSlot,
}: {
  rail: ReactNode;
  onSlot: (el: HTMLElement | null) => void;
}) {
  const shell = useShell();
  if (!shell?.compact) return null;
  return (
    <Drawer
      open={shell.navOpen}
      onClose={() => shell.setNavOpen(false)}
      side="left"
      label="Navegação"
      className="h-dvh"
    >
      <div className="flex min-h-0 flex-1">
        {rail}
        <div ref={onSlot} className="flex min-h-0 min-w-0 empty:hidden" />
      </div>
    </Drawer>
  );
}

/** Botão "menu" do cabeçalho: abre a navegação em telas estreitas; some a partir de 768 px. */
export function NavToggle({ className }: { className?: string }) {
  const shell = useShell();
  if (!shell) return null;
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Abrir menu de navegação"
      aria-expanded={shell.navOpen}
      className={cn("-ml-2 shrink-0 md:hidden", className)}
      onClick={() => shell.setNavOpen(true)}
    >
      <Menu />
    </Button>
  );
}

/** Botão que abre o painel de membros em telas sem espaço para ele (< 1024 px). */
export function MembersToggle({ className }: { className?: string }) {
  const shell = useShell();
  if (!shell) return null;
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Mostrar membros"
      aria-expanded={shell.membersOpen}
      className={cn("lg:hidden", className)}
      onClick={() => shell.setMembersOpen(true)}
    >
      <Users />
    </Button>
  );
}

/**
 * Âncora da lista lateral esquerda de uma tela (canais de um servidor, conversas): em desktop é só o
 * filho no fluxo; em tela estreita é montado dentro do drawer de navegação, mantendo o estado do React.
 */
export function ShellSidebar({ children }: { children: ReactNode }) {
  const shell = useShell();
  if (shell?.compact) return shell.navSlot ? createPortal(children, shell.navSlot) : null;
  return <>{children}</>;
}

/**
 * Painel lateral direito (membros, no futuro fixadas/detalhes): em desktop (>= 1024 px) é um `aside`
 * fixo no fluxo com `className`; abaixo disso é um sheet que desliza pela direita, aberto por `MembersToggle`.
 */
export function SideSheet({
  label,
  className,
  children,
}: {
  label: string;
  /** Classes do painel fixo de desktop. */
  className?: string;
  children: ReactNode;
}) {
  const shell = useShell();
  const compact = useMediaQuery(SIDE_COMPACT_QUERY);
  if (!shell || !compact)
    return (
      <aside aria-label={label} className={cn("hidden lg:flex", className)}>
        {children}
      </aside>
    );
  return (
    <Drawer
      open={shell.membersOpen}
      onClose={() => shell.setMembersOpen(false)}
      side="right"
      label={label}
      className="h-dvh w-72"
    >
      <aside aria-label={label} className="flex min-h-0 flex-1 flex-col">
        {children}
      </aside>
    </Drawer>
  );
}
