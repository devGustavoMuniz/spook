import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Check, Copy, Download, ExternalLink, MonitorSmartphone, RotateCw } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Lettering, LogoMark } from "@/components/brand";
import {
  EmptyChatIllustration,
  ErrorIllustration,
  VoiceInviteIllustration,
} from "@/components/illustrations";
import { RichText } from "@/components/rich-text";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getLocale, type MessageKey, useT } from "@/i18n";
import { formatBytes } from "@/lib/file-size";
import { cn } from "@/lib/utils";
import { type Arch, detectArch, detectPlatform, type Os } from "./platform";
import {
  type Installer,
  installersFor,
  KIND_LABEL_KEY,
  loadLatestRelease,
  primaryInstaller,
  RELEASES_PAGE_URL,
  type Release,
  ReleaseError,
  recommendedTarget,
  TARGETS,
  type Target,
} from "./releases";

const formatDate = (iso: string) =>
  new Intl.DateTimeFormat(getLocale(), { dateStyle: "long" }).format(new Date(iso));

/** `/download`: página pública (sem login) para baixar o app desktop, a partir do último release do GitHub. */
export function DownloadPage() {
  const { t } = useT();
  const platform = detectPlatform(typeof navigator === "undefined" ? undefined : navigator);
  const [arch, setArch] = useState<Arch | null>(null);
  useEffect(() => {
    let alive = true;
    void detectArch(navigator).then((a) => alive && setArch(a));
    return () => {
      alive = false;
    };
  }, []);

  const query = useQuery({
    queryKey: ["latest-desktop-release"],
    queryFn: () => loadLatestRelease(),
    retry: false,
    staleTime: 10 * 60 * 1000,
  });
  const recommended = recommendedTarget(platform.os, arch);

  return (
    <div className="min-h-svh bg-brand-glow text-foreground">
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between gap-3 px-4 py-4 sm:px-6">
        <Link
          to="/"
          className="flex items-center gap-2 rounded-lg"
          aria-label={t("shell.download.homeAria")}
        >
          <LogoMark size={36} alt="" />
          <Lettering width={96} className="w-24" />
        </Link>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline">
            <Link to="/">{t("shell.download.openBrowser")}</Link>
          </Button>
          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-5xl flex-col gap-10 px-4 pt-4 pb-16 sm:px-6">
        <section
          className="grid items-center gap-6 md:grid-cols-[1fr_auto]"
          aria-labelledby="dl-title"
        >
          <div className="flex flex-col gap-4">
            <h1
              id="dl-title"
              className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl"
            >
              {t("shell.download.title")}
            </h1>
            <p className="max-w-xl text-pretty text-muted-foreground">
              {t("shell.download.intro")}
            </p>
            <Hero
              loading={query.isPending}
              error={query.error}
              release={query.data}
              mobile={platform.mobile}
              os={platform.os}
              recommended={recommended}
              onRetry={() => void query.refetch()}
              retrying={query.isFetching}
            />
          </div>
          <VoiceInviteIllustration className="hidden h-48 w-auto md:block" />
        </section>

        {query.data ? (
          <section aria-labelledby="dl-all" className="flex flex-col gap-4">
            <h2 id="dl-all" className="text-xl font-semibold tracking-tight">
              {t("shell.download.allPlatforms")}
            </h2>
            <ul className="grid gap-4 sm:grid-cols-2">
              {TARGETS.map((target) => (
                <li key={target.id}>
                  <TargetCard
                    target={target}
                    release={query.data as Release}
                    highlighted={recommended?.id === target.id}
                  />
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <InstallHelp highlight={platform.os} />
      </main>
    </div>
  );
}

function Hero({
  loading,
  error,
  release,
  mobile,
  os,
  recommended,
  onRetry,
  retrying,
}: {
  loading: boolean;
  error: unknown;
  release: Release | null | undefined;
  mobile: boolean;
  os: Os | null;
  recommended: Target | null;
  onRetry: () => void;
  retrying: boolean;
}) {
  const { t } = useT();
  if (loading)
    return (
      <output aria-label={t("shell.download.loadingAria")}>
        <Skeleton className="h-12 w-72" />
      </output>
    );
  if (error) return <FailureNotice error={error} onRetry={onRetry} retrying={retrying} />;
  if (!release) {
    return (
      <div className="flex max-w-xl flex-col items-start gap-3 rounded-xl border border-border bg-card p-5 shadow-sm">
        <EmptyChatIllustration className="h-28 w-auto" />
        <h2 className="text-lg font-semibold tracking-tight">
          {t("shell.download.noReleaseTitle")}
        </h2>
        <p className="text-sm text-pretty text-muted-foreground">
          {t("shell.download.noReleaseBody")}
        </p>
        <Button asChild>
          <Link to="/">{t("shell.download.openBrowser")}</Link>
        </Button>
      </div>
    );
  }
  if (mobile) {
    return (
      <p className="flex max-w-xl items-start gap-2 rounded-xl border border-border bg-card p-4 text-sm text-pretty shadow-sm">
        <MonitorSmartphone className="mt-0.5 size-4 shrink-0 text-brand-text" aria-hidden />
        {t("shell.download.mobileNote")}
      </p>
    );
  }
  const main = recommended ? primaryInstaller(installersFor(release, recommended)) : null;
  return (
    <div className="flex flex-col items-start gap-2">
      {main && recommended ? (
        <>
          <Button asChild size="xl">
            <a href={main.url} download>
              <Download aria-hidden />{" "}
              {t("shell.download.downloadFor", { target: t(recommended.titleKey) })}
            </a>
          </Button>
          <p className="text-sm text-muted-foreground">
            {t("shell.download.versionMeta", {
              version: release.version,
              kind: t(KIND_LABEL_KEY[main.kind]),
              size: formatBytes(main.size),
            })}
            {release.publishedAt ? ` · ${formatDate(release.publishedAt)}` : ""}
          </p>
          {os === "macos" ? (
            <p className="text-xs text-muted-foreground">{t("shell.download.macNote")}</p>
          ) : null}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          {t("shell.download.pickSystem", { version: release.version })}
        </p>
      )}
    </div>
  );
}

function FailureNotice({
  error,
  onRetry,
  retrying,
}: {
  error: unknown;
  onRetry: () => void;
  retrying: boolean;
}) {
  const { t } = useT();
  const reason = error instanceof ReleaseError ? error.reason : "error";
  const text =
    reason === "rate-limit"
      ? t("shell.download.failRateLimit")
      : reason === "network"
        ? t("shell.download.failNetwork")
        : t("shell.download.failGeneric");
  return (
    <div
      role="alert"
      className="flex max-w-xl flex-col items-start gap-3 rounded-xl border border-border bg-card p-5 shadow-sm"
    >
      <ErrorIllustration className="h-28 w-auto" />
      <h2 className="text-lg font-semibold tracking-tight">{t("shell.download.failTitle")}</h2>
      <p className="text-sm text-pretty text-muted-foreground">{text}</p>
      <div className="flex flex-wrap gap-2">
        <Button onClick={onRetry} loading={retrying}>
          <RotateCw aria-hidden /> {t("common.retry")}
        </Button>
        <Button asChild variant="outline">
          <a href={RELEASES_PAGE_URL} target="_blank" rel="noreferrer">
            {t("shell.download.releasesLink")} <ExternalLink aria-hidden />
          </a>
        </Button>
      </div>
    </div>
  );
}

function TargetCard({
  target,
  release,
  highlighted,
}: {
  target: Target;
  release: Release;
  highlighted: boolean;
}) {
  const { t } = useT();
  const list = installersFor(release, target);
  return (
    <Card
      className={cn("h-full gap-3 py-4", highlighted && "border-brand-400 ring-1 ring-brand-400")}
      aria-label={t(target.titleKey)}
    >
      <div className="flex flex-col gap-0.5 px-4">
        <h3 className="flex items-center gap-2 font-semibold tracking-tight">
          {t(target.titleKey)}
          {highlighted ? (
            <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-medium text-brand-text">
              {t("shell.download.recommended")}
            </span>
          ) : null}
        </h3>
        <p className="text-xs text-pretty text-muted-foreground">{t(target.subtitleKey)}</p>
        <p className="text-xs text-muted-foreground">
          {t("shell.download.versionOnly", { version: release.version })}
          {release.publishedAt ? ` · ${formatDate(release.publishedAt)}` : ""}
        </p>
      </div>
      {list.length === 0 ? (
        <p className="px-4 text-sm text-muted-foreground">{t("shell.download.unavailable")}</p>
      ) : (
        <ul className="flex flex-col gap-3 px-4">
          {list.map((i) => (
            <li key={i.name} className="flex flex-col gap-1.5">
              <Button
                asChild
                variant={highlighted ? "default" : "outline"}
                className="justify-start"
              >
                <a href={i.url} download>
                  <Download aria-hidden /> {t(KIND_LABEL_KEY[i.kind])} · {formatBytes(i.size)}
                </a>
              </Button>
              <Checksum installer={i} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Checksum({ installer }: { installer: Installer }) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  if (!installer.sha256) {
    return installer.checksumUrl ? (
      <a
        href={installer.checksumUrl}
        className="text-xs text-brand-text underline-offset-4 hover:underline"
      >
        {t("shell.download.sha256File")}
      </a>
    ) : null;
  }
  const sha = installer.sha256;
  async function copy() {
    try {
      await navigator.clipboard.writeText(sha);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(t("shell.download.copyFail"));
    }
  }
  return (
    <div className="flex items-start gap-1 text-xs text-muted-foreground">
      <span className="min-w-0 flex-1">
        SHA-256: <code className="font-mono break-all">{sha}</code>
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t("shell.download.copySha", { name: installer.name })}
        onClick={() => void copy()}
      >
        {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      </Button>
    </div>
  );
}

function InstallHelp({ highlight }: { highlight: Os | null }) {
  const { t } = useT();
  const block = "rounded-xl border border-border bg-card shadow-sm";
  const summary =
    "flex min-h-11 cursor-pointer items-center justify-between gap-2 rounded-xl px-4 py-3 text-sm font-semibold hover:bg-accent";
  const code = "rounded bg-secondary px-1.5 py-0.5 font-mono text-xs break-all";
  const tags = {
    b: (c: string) => <strong>{c}</strong>,
    q: (c: string) => <q>{c}</q>,
    code: (c: string) => <code className={code}>{c}</code>,
  };
  const rich = (key: MessageKey) => <RichText text={t(key)} tags={tags} />;
  return (
    <section aria-labelledby="dl-help" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id="dl-help" className="text-xl font-semibold tracking-tight">
          {t("shell.download.help.title")}
        </h2>
        <p className="max-w-2xl text-sm text-pretty text-muted-foreground">
          {rich("shell.download.help.intro")}
        </p>
      </div>
      <details className={block} open={highlight === "windows"}>
        <summary className={summary}>{t("shell.download.help.win.summary")}</summary>
        <ol className="flex list-decimal flex-col gap-1.5 px-8 pb-4 text-sm text-pretty">
          <li>{t("shell.download.help.win.step1")}</li>
          <li>{rich("shell.download.help.win.step2")}</li>
          <li>{rich("shell.download.help.win.step3")}</li>
          <li>{rich("shell.download.help.win.step4")}</li>
        </ol>
      </details>
      <details className={block} open={highlight === "macos"}>
        <summary className={summary}>{t("shell.download.help.mac.summary")}</summary>
        <ol className="flex list-decimal flex-col gap-1.5 px-8 pb-4 text-sm text-pretty">
          <li>{rich("shell.download.help.mac.step1")}</li>
          <li>{rich("shell.download.help.mac.step2")}</li>
          <li>{rich("shell.download.help.mac.step3")}</li>
          <li>{rich("shell.download.help.mac.step4")}</li>
        </ol>
      </details>
      <details className={block} open={highlight === "linux"}>
        <summary className={summary}>{t("shell.download.help.linux.summary")}</summary>
        <ol className="flex list-decimal flex-col gap-1.5 px-8 pb-4 text-sm text-pretty">
          <li>{rich("shell.download.help.linux.step1")}</li>
          <li>{rich("shell.download.help.linux.step2")}</li>
          <li>{t("shell.download.help.linux.step3")}</li>
          <li>{rich("shell.download.help.linux.step4")}</li>
        </ol>
      </details>
    </section>
  );
}
