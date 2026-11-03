import { useAuthProviders } from "@spook/shared";
import { Button } from "@/components/ui/button";
import { isTauri } from "@/desktop/runtime";
import { useT } from "@/i18n";

const LABELS: Record<string, string> = { google: "Google", discord: "Discord" };

/** Ícones simples e monocromáticos (herdam a cor do texto): sem logos oficiais pesadas. */
function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M21.35 11.1H12v3.8h5.35c-.5 2.4-2.55 3.8-5.35 3.8a6.2 6.2 0 1 1 0-12.4c1.5 0 2.85.55 3.9 1.45l2.7-2.7A10 10 0 1 0 12 22c5.75 0 9.6-4.05 9.6-9.75 0-.4-.05-.8-.25-1.15Z" />
    </svg>
  );
}

function DiscordIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M20 5.5A17 17 0 0 0 15.8 4l-.2.4a12 12 0 0 1 3.6 1.8 13 13 0 0 0-14.4 0A12 12 0 0 1 8.4 4.4L8.2 4A17 17 0 0 0 4 5.5C1.3 9.5.6 13.4 1 17.2a17 17 0 0 0 5.2 2.6l1.1-1.8c-.6-.2-1.2-.5-1.7-.9l.4-.3a12 12 0 0 0 10 0l.4.3c-.5.4-1.1.7-1.7.9l1.1 1.8a17 17 0 0 0 5.2-2.6c.5-4.4-.8-8.3-3-11.7ZM9 14.8c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2Zm6 0c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2Z" />
    </svg>
  );
}

const ICONS: Record<string, () => React.JSX.Element> = { google: GoogleIcon, discord: DiscordIcon };

/** URL que inicia o fluxo OAuth no backend (navegação completa, não fetch). */
export function socialStartUrl(
  provider: string,
  opts: { intent?: "login" | "link" | "reauth"; redirect?: string } = {},
): string {
  const q = new URLSearchParams();
  if (opts.intent && opts.intent !== "login") q.set("intent", opts.intent);
  if (opts.redirect) q.set("redirect", opts.redirect);
  const qs = q.toString();
  return `/api/auth/social/${provider}/start${qs ? `?${qs}` : ""}`;
}

/**
 * "Continuar com Google/Discord": só aparece para os provedores ligados no servidor
 * (`GET /api/auth/providers`) e fora do app desktop (o login do desktop usa o navegador, ver `browser-login.ts`).
 */
export function SocialButtons({ redirect }: { redirect?: string }) {
  const { t } = useT();
  const { data } = useAuthProviders({ query: { staleTime: 60_000 } });
  const providers = data?.providers ?? [];
  if (providers.length === 0 || isTauri()) return null;
  return (
    <div className="flex flex-col gap-3" data-testid="social-buttons">
      <div className="flex items-center gap-3 text-xs text-muted-foreground" aria-hidden="true">
        <span className="h-px flex-1 bg-border" />
        {t("auth.social.or")}
        <span className="h-px flex-1 bg-border" />
      </div>
      {providers.map((p) => {
        const Icon = ICONS[p];
        return (
          <Button key={p} asChild variant="outline" size="xl" className="w-full">
            <a href={socialStartUrl(p, { redirect })}>
              {Icon ? <Icon /> : null}
              {t("auth.social.continueWith", { provider: LABELS[p] ?? p })}
            </a>
          </Button>
        );
      })}
    </div>
  );
}
