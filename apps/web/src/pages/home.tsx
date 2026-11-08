import { useListGuilds } from "@spook/shared";
import { Navigate } from "@tanstack/react-router";
import { ArrowRight, Compass, Plus } from "lucide-react";
import { useState } from "react";
import { LogoMark } from "@/components/brand";
import { NavToggle } from "@/components/shell";
import { ErrorState } from "@/components/state-screen";
import { Skeleton } from "@/components/ui/skeleton";
import { DownloadAppButton } from "@/features/download/download-link";
import { AddServerDialog } from "@/features/guilds/add-server-dialog";
import { useT } from "@/i18n";
import { lastLocation } from "@/lib/last-location";

const keepSearch = ((prev: Record<string, unknown>) => prev) as never;

/** `/`: vai ao último servidor visitado (ou ao primeiro); sem servidores, mostra o estado vazio. */
export function HomePage() {
  const { t } = useT();
  const guilds = useListGuilds();
  const [dialog, setDialog] = useState<"create" | "join" | null>(null);

  if (guilds.isPending)
    return (
      <output className="flex h-full flex-col items-center justify-center gap-3 p-6">
        <Skeleton className="size-24 rounded-3xl" />
        <Skeleton className="h-5 w-56" />
        <span className="sr-only">{t("shell.home.loading")}</span>
      </output>
    );
  if (guilds.isError)
    return (
      <ErrorState
        error={guilds.error}
        onRetry={() => void guilds.refetch()}
        retrying={guilds.isFetching}
      />
    );

  const list = guilds.data ?? [];
  if (list.length > 0) {
    const target = list.find((g) => g.id === lastLocation.guild()) ?? list[0];
    // `search` acompanha o redirecionamento: `?settings=` (modal de configurações aberto por link direto) não se perde.
    if (target)
      return (
        <Navigate
          to="/channels/$guildId"
          params={{ guildId: target.id }}
          search={keepSearch}
          replace
        />
      );
  }

  return (
    <main className="relative flex h-full flex-col items-center justify-center gap-8 overflow-y-auto bg-brand-glow p-6 text-center">
      <NavToggle className="absolute top-2 left-4" />
      <div className="flex flex-col items-center gap-4">
        <LogoMark size={112} glow />
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-tight text-balance">
            {t("shell.home.emptyTitle")}
          </h1>
          <p className="mx-auto max-w-md text-base text-muted-foreground text-pretty">
            {t("shell.home.emptyBody")}
          </p>
        </div>
      </div>
      <div className="grid w-full max-w-2xl gap-3 sm:grid-cols-2">
        <ActionCard
          id="create"
          icon={Plus}
          title={t("shell.home.createTitle")}
          description={t("shell.home.createBody")}
          onClick={() => setDialog("create")}
        />
        <ActionCard
          id="join"
          icon={Compass}
          title={t("shell.home.joinTitle")}
          description={t("shell.home.joinBody")}
          onClick={() => setDialog("join")}
        />
      </div>
      <DownloadAppButton variant="outline" />
      <AddServerDialog
        key={dialog ?? "closed"}
        open={dialog !== null}
        initialTab={dialog ?? "create"}
        onOpenChange={(o) => !o && setDialog(null)}
      />
    </main>
  );
}

function ActionCard({
  id,
  icon: Icon,
  title,
  description,
  onClick,
}: {
  id: string;
  icon: typeof Plus;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-desc`}
      className="group flex items-center gap-4 rounded-xl border border-border bg-card p-4 text-left shadow-sm transition-[border-color,box-shadow,background-color] hover:border-brand-400 hover:bg-surface-2 hover:shadow-md"
    >
      <span
        aria-hidden
        className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-accent text-brand-text"
      >
        <Icon className="size-6" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span id={`${id}-title`} className="font-semibold">
          {title}
        </span>
        <span id={`${id}-desc`} className="text-sm text-muted-foreground text-pretty">
          {description}
        </span>
      </span>
      <ArrowRight
        aria-hidden
        className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
      />
    </button>
  );
}
