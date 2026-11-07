import { useGetMe } from "@spook/shared";
import { Link, Navigate, Outlet, useRouter, useRouterState } from "@tanstack/react-router";
import { ArrowLeft, ChevronRight, LogOut, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { useSignOut } from "@/auth/use-sign-out";
import { Avatar } from "@/components/avatar";
import { NAV_COMPACT_QUERY, useMediaQuery } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { isTauri } from "@/desktop/runtime";
import { DownloadAppButton } from "@/features/download/download-link";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import { returnPath } from "./return-path";
import { SECTIONS, sectionOf } from "./sections";

/** Hrefs tipados: uma rota por seção. */
const TO = {
  profile: "/settings/profile",
  notifications: "/settings/notifications",
  blocked: "/settings/blocked",
  voice: "/settings/voice",
  appearance: "/settings/appearance",
  app: "/settings/app",
} as const;

/** Esc não deve fechar as configurações se ele já fechou um diálogo, menu ou lista aberta. */
function overlayOpen() {
  return !!document.querySelector(
    '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]',
  );
}

/**
 * Área de configurações em tela cheia: navegação lateral + conteúdo. Abaixo de 768 px vira lista -> detalhe.
 * Fechar (botão ou Esc) volta para a tela em que a pessoa estava.
 */
export function SettingsLayout() {
  const { t } = useT();
  const compact = useMediaQuery(NAV_COMPACT_QUERY);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const router = useRouter();
  const segment = pathname.replace(/\/+$/, "").split("/")[2];
  const section = sectionOf(segment);
  const atIndex = !segment;
  const showNav = !compact || atIndex;
  const showDetail = !compact || !atIndex;
  const heading = useRef<HTMLHeadingElement>(null);

  const close = () => router.history.push(returnPath());
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || overlayOpen()) return;
      closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Foco no título ao entrar e a cada troca de seção (leitor de tela anuncia onde está).
  // biome-ignore lint/correctness/useExhaustiveDependencies: refocar só quando a seção ou a visão mudam
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, [segment, compact]);

  // Ao sair, o layout ainda renderiza um instante com o novo endereço: não redirecionar de volta.
  if (!pathname.startsWith("/settings")) return null;
  if (atIndex && !compact) return <Navigate to={TO.profile} replace />;
  // /settings/<desconhecido> cai no 404 do app
  if (!atIndex && !section) return <Navigate to="/settings" replace />;

  return (
    <div className="relative flex h-dvh overflow-hidden bg-background pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-foreground">
      {showNav ? (
        <SettingsNav
          compact={compact}
          onClose={close}
          heading={compact && atIndex ? heading : undefined}
        />
      ) : null}
      {showDetail && section ? (
        <div className="relative flex min-w-0 flex-1 flex-col">
          {compact ? (
            <div className="flex items-center justify-between gap-2 border-b px-2 py-2">
              <Button asChild variant="ghost" size="sm">
                <Link to="/settings" aria-label={t("settings.layout.backToSettings")}>
                  <ArrowLeft aria-hidden /> {t("settings.layout.title")}
                </Link>
              </Button>
              <CloseButton onClose={close} compact />
            </div>
          ) : (
            <div className="absolute top-8 right-8 z-10 flex flex-col items-center gap-1.5">
              <CloseButton onClose={close} />
              <Kbd aria-hidden>Esc</Kbd>
            </div>
          )}
          <main className="min-h-0 flex-1 overflow-y-auto" aria-labelledby="settings-title">
            <div className="mx-auto flex w-full max-w-[44rem] flex-col gap-6 px-4 pt-6 pb-16 md:px-8 md:pt-14">
              <header className="flex items-start gap-3.5">
                <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-accent text-brand-text">
                  <section.icon className="size-5" aria-hidden />
                </span>
                <div className="min-w-0">
                  <h1
                    id="settings-title"
                    ref={heading}
                    tabIndex={-1}
                    className="text-2xl leading-tight font-semibold tracking-tight outline-none"
                  >
                    {t(section.labelKey)}
                  </h1>
                  <p className="mt-1 text-sm text-pretty text-muted-foreground">
                    {t(section.descriptionKey)}
                  </p>
                </div>
              </header>
              <Outlet />
            </div>
          </main>
        </div>
      ) : null}
    </div>
  );
}

function CloseButton({ onClose, compact }: { onClose: () => void; compact?: boolean }) {
  const { t } = useT();
  return (
    <Button
      variant="outline"
      size={compact ? "icon-sm" : "icon-lg"}
      className={compact ? undefined : "rounded-full"}
      aria-label={t("settings.layout.close")}
      onClick={onClose}
    >
      <X className={compact ? undefined : "size-5"} aria-hidden />
    </Button>
  );
}

function SettingsNav({
  compact,
  onClose,
  heading,
}: {
  compact: boolean;
  onClose: () => void;
  heading?: React.RefObject<HTMLHeadingElement | null>;
}) {
  const { t } = useT();
  const { data: me } = useGetMe();
  const { signOut, pending } = useSignOut();
  const name = me ? me.display_name || me.username : "";
  const items = SECTIONS.filter((s) => !s.desktopOnly || isTauri());
  return (
    <div
      className={cn(
        "flex shrink-0 flex-col bg-sidebar",
        compact ? "w-full" : "w-72 border-r lg:w-80",
      )}
    >
      {compact ? (
        <div className="flex items-center justify-between gap-2 px-4 pt-3">
          <h1
            ref={heading}
            tabIndex={-1}
            className="text-2xl font-semibold tracking-tight outline-none"
          >
            {t("settings.layout.title")}
          </h1>
          <CloseButton onClose={onClose} compact />
        </div>
      ) : null}
      {me ? (
        <div className="flex items-center gap-3 px-4 pt-5 pb-3 md:px-6 md:pt-10">
          <Avatar url={me.avatar_url} name={name} size={44} />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{name}</p>
            <p className="truncate text-xs text-muted-foreground">@{me.username}</p>
          </div>
        </div>
      ) : null}
      <nav
        aria-label={t("settings.layout.navLabel")}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-2"
      >
        <ul className="flex flex-col gap-0.5">
          {items.map((s) => (
            <li key={s.key}>
              <Link
                to={TO[s.key]}
                className="group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground aria-[current=page]:bg-accent aria-[current=page]:text-foreground"
              >
                <s.icon
                  className="size-[18px] group-aria-[current=page]:text-brand-text"
                  aria-hidden
                />
                <span className="flex-1">{t(s.labelKey)}</span>
                {compact ? <ChevronRight className="size-4" aria-hidden /> : null}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <div className="flex flex-col gap-1 border-t p-3">
        {isTauri() ? null : (
          <div className="[&_a]:w-full [&_a]:justify-start [&_a]:gap-3 [&_a]:px-3 [&_svg]:size-[18px]">
            <DownloadAppButton />
          </div>
        )}
        <Button
          variant="ghost"
          className="w-full justify-start gap-3 px-3 text-destructive-text hover:text-destructive-text"
          onClick={signOut}
          disabled={pending}
        >
          <LogOut className="size-[18px]" aria-hidden /> {t("settings.layout.signOut")}
        </Button>
      </div>
    </div>
  );
}
