import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useGetMe } from "@spook/shared";
import { ArrowLeft, ChevronRight, LogOut, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef } from "react";
import { useSignOut } from "@/auth/use-sign-out";
import { Avatar } from "@/components/avatar";
import { NAV_COMPACT_QUERY, useMediaQuery } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { overlayClass } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { isTauri } from "@/desktop/runtime";
import { DownloadAppButton } from "@/features/download/download-link";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import { AppSettingsPage } from "@/pages/app-settings";
import { NotificationsPage } from "@/pages/notifications";
import { ProfilePage } from "@/pages/profile";
import { AppearancePage } from "@/pages/settings-appearance";
import { BlockedPage } from "@/pages/settings-blocked";
import { VoiceSettingsPage } from "@/pages/settings-voice";
import { GROUPS, SECTIONS, type SectionKey, sectionOf } from "./sections";
import { settingsHref, useSettingsNav, useSettingsView } from "./use-settings";

const PAGES: Record<SectionKey, () => React.ReactNode> = {
  profile: () => <ProfilePage />,
  notifications: () => <NotificationsPage />,
  blocked: () => <BlockedPage />,
  voice: () => <VoiceSettingsPage />,
  appearance: () => <AppearancePage />,
  app: () => <AppSettingsPage />,
};

/**
 * Configurações em modal grande sobre o app (o app, a chamada e a rolagem do chat continuam montados atrás).
 * O estado é o parâmetro `?settings=` da rota atual, mascarado como `/settings/<seção>` (deep link). Abaixo
 * de 768 px vira uma folha em tela cheia com lista -> detalhe.
 */
export function SettingsModal() {
  const view = useSettingsView();
  const { close } = useSettingsNav();
  const { t } = useT();
  // Sem `Trigger`, o Radix não sabe quem abriu: guardamos o elemento em foco na abertura e o devolvemos ao fechar.
  const opener = useRef<HTMLElement | null>(null);
  return (
    <DialogPrimitive.Root open={view !== undefined} onOpenChange={(o) => !o && close()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={overlayClass} />
        <DialogPrimitive.Content
          aria-modal="true"
          onOpenAutoFocus={(e) => {
            opener.current =
              document.activeElement instanceof HTMLElement ? document.activeElement : null;
            // foco inicial no item atual do menu (tela larga) em vez do primeiro botão que o Radix achar
            const current = e.currentTarget as HTMLElement | null;
            const item = current?.querySelector<HTMLElement>('[data-menu-item][tabindex="0"]');
            if (item) {
              e.preventDefault();
              item.focus({ preventScroll: true });
            }
          }}
          onCloseAutoFocus={(e) => {
            const el = opener.current;
            if (el?.isConnected && el !== document.body) {
              e.preventDefault();
              el.focus({ preventScroll: true });
            }
          }}
          aria-describedby={undefined}
          className="fixed inset-0 z-[var(--z-modal)] m-auto flex h-dvh w-full overflow-hidden border-border bg-background pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-foreground shadow-xl outline-none data-[state=closed]:animate-dialog-out data-[state=open]:animate-dialog-in md:h-[min(760px,92svh)] md:w-[min(1100px,96vw)] md:rounded-2xl md:border md:pt-0 md:pb-0"
        >
          <DialogPrimitive.Title className="sr-only">
            {t("settings.layout.title")}
          </DialogPrimitive.Title>
          {view ? <ModalBody view={view} /> : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function ModalBody({ view }: { view: NonNullable<ReturnType<typeof useSettingsView>> }) {
  const { t } = useT();
  const compact = useMediaQuery(NAV_COMPACT_QUERY);
  const { show, close } = useSettingsNav();
  const heading = useRef<HTMLHeadingElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  // Tela larga não tem "lista": `menu` vira a última seção (ou o perfil).
  const section = view === "menu" ? undefined : sectionOf(view);
  const showMenu = !compact || view === "menu";
  const showDetail = !compact || view !== "menu";

  useEffect(() => {
    if (!compact && view === "menu") void show("profile");
  }, [compact, view, show]);

  // Troca de seção: o conteúdo volta ao topo; em tela estreita o título recebe o foco (leitor de tela anuncia).
  // biome-ignore lint/correctness/useExhaustiveDependencies: reagir só à troca de visão
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
    if (compact) heading.current?.focus({ preventScroll: true });
  }, [view, compact]);

  return (
    <>
      {showMenu ? <SettingsMenu view={view} compact={compact} onClose={close} /> : null}
      {showDetail && section ? (
        <div className="relative flex min-w-0 flex-1 flex-col bg-background">
          {compact ? (
            <div className="flex items-center justify-between gap-2 border-b px-2 py-2">
              <Button
                variant="ghost"
                size="sm"
                aria-label={t("settings.layout.backToSettings")}
                onClick={() => void show("menu")}
              >
                <ArrowLeft aria-hidden /> {t("settings.layout.title")}
              </Button>
              <CloseButton onClose={close} compact />
            </div>
          ) : (
            <div className="absolute top-5 right-6 z-10 flex flex-col items-center gap-1.5">
              <CloseButton onClose={close} />
              <Kbd aria-hidden>Esc</Kbd>
            </div>
          )}
          <main
            ref={scroller}
            aria-labelledby="settings-title"
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
          >
            <div className="mx-auto flex w-full max-w-[44rem] flex-col gap-6 px-4 pt-6 pb-16 md:pr-20 md:pl-10 md:pt-10">
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
              {PAGES[section.key]()}
            </div>
          </main>
        </div>
      ) : null}
    </>
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

/** Menu lateral agrupado. Setas (e Home/End) movem o foco; só o item atual entra na ordem de Tab. */
function SettingsMenu({
  view,
  compact,
  onClose,
}: {
  view: string;
  compact: boolean;
  onClose: () => void;
}) {
  const { t } = useT();
  const { data: me } = useGetMe();
  const { signOut, pending } = useSignOut();
  const { show } = useSettingsNav();
  const name = me ? me.display_name || me.username : "";
  const visible = SECTIONS.filter((s) => !s.desktopOnly || isTauri());
  const tabbable = visible.some((s) => s.key === view) ? view : visible[0]?.key;
  const heading = useRef<HTMLHeadingElement>(null);

  function onKeyDown(e: KeyboardEvent<HTMLElement>) {
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!keys.includes(e.key)) return;
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("[data-menu-item]"));
    const at = items.indexOf(document.activeElement as HTMLElement);
    let next = at;
    if (e.key === "ArrowDown") next = (at + 1) % items.length;
    else if (e.key === "ArrowUp") next = (at - 1 + items.length) % items.length;
    else if (e.key === "Home") next = 0;
    else next = items.length - 1;
    e.preventDefault();
    items[next]?.focus();
  }

  return (
    <div
      className={cn(
        "flex shrink-0 flex-col bg-sidebar",
        compact ? "w-full" : "w-64 border-r lg:w-72",
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
        <div className="flex items-center gap-3 px-4 pt-5 pb-3 md:px-5 md:pt-6">
          <Avatar url={me.avatar_url} name={name} size={40} />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{name}</p>
            <p className="truncate text-xs text-muted-foreground">@{me.username}</p>
          </div>
        </div>
      ) : null}
      <nav
        aria-label={t("settings.layout.navLabel")}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-2"
        onKeyDown={onKeyDown}
      >
        {GROUPS.map((g) => {
          const items = visible.filter((s) => s.group === g.key);
          if (items.length === 0) return null;
          const gid = `settings-group-${g.key}`;
          return (
            <section key={g.key} aria-labelledby={gid} className="mb-3">
              <h2
                id={gid}
                className="px-3 pt-2 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
              >
                {t(g.labelKey)}
              </h2>
              <ul className="flex flex-col gap-0.5">
                {items.map((s) => (
                  <li key={s.key}>
                    <a
                      href={settingsHref(s.key)}
                      data-menu-item
                      tabIndex={s.key === tabbable ? 0 : -1}
                      aria-current={view === s.key ? "page" : undefined}
                      onClick={(e) => {
                        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
                        e.preventDefault();
                        void show(s.key);
                      }}
                      className="group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-accent aria-[current=page]:text-foreground"
                    >
                      <s.icon
                        className="size-[18px] group-aria-[current=page]:text-brand-text"
                        aria-hidden
                      />
                      <span className="flex-1">{t(s.labelKey)}</span>
                      {compact ? <ChevronRight className="size-4" aria-hidden /> : null}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
        <div className="flex flex-col gap-1 border-t pt-3">
          {isTauri() ? null : (
            <div className="[&_a]:w-full [&_a]:justify-start [&_a]:gap-3 [&_a]:px-3 [&_svg]:size-[18px]">
              <DownloadAppButton />
            </div>
          )}
          <Button
            variant="ghost"
            data-menu-item
            tabIndex={-1}
            className="w-full justify-start gap-3 px-3 text-destructive-text hover:text-destructive-text"
            onClick={signOut}
            disabled={pending}
          >
            <LogOut className="size-[18px]" aria-hidden /> {t("settings.layout.signOut")}
          </Button>
        </div>
      </nav>
    </div>
  );
}
