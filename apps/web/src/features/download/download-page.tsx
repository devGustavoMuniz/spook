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
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatBytes } from "@/lib/file-size";
import { cn } from "@/lib/utils";
import { type Arch, detectArch, detectPlatform, type Os } from "./platform";
import {
  type Installer,
  installersFor,
  KIND_LABEL,
  loadLatestRelease,
  primaryInstaller,
  RELEASES_PAGE_URL,
  type Release,
  ReleaseError,
  recommendedTarget,
  TARGETS,
  type Target,
} from "./releases";

const date = new Intl.DateTimeFormat("pt-BR", { dateStyle: "long" });

/** `/download`: página pública (sem login) para baixar o app desktop, a partir do último release do GitHub. */
export function DownloadPage() {
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
          aria-label="Spook, ir para o início"
        >
          <LogoMark size={36} alt="" />
          <Lettering width={96} className="w-24" />
        </Link>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline">
            <Link to="/">Abrir no navegador</Link>
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
              Baixe o Spook para o seu computador
            </h1>
            <p className="max-w-xl text-pretty text-muted-foreground">
              Voz, vídeo e compartilhamento de tela nativos, notificações do sistema, bandeja e
              atualização automática. Também funciona no navegador, sem instalar nada.
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
              Todas as plataformas
            </h2>
            <ul className="grid gap-4 sm:grid-cols-2">
              {TARGETS.map((t) => (
                <li key={t.id}>
                  <TargetCard
                    target={t}
                    release={query.data as Release}
                    highlighted={recommended?.id === t.id}
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
  if (loading)
    return (
      <output aria-label="Carregando a versão mais recente">
        <Skeleton className="h-12 w-72" />
      </output>
    );
  if (error) return <FailureNotice error={error} onRetry={onRetry} retrying={retrying} />;
  if (!release) {
    return (
      <div className="flex max-w-xl flex-col items-start gap-3 rounded-xl border border-border bg-card p-5 shadow-sm">
        <EmptyChatIllustration className="h-28 w-auto" />
        <h2 className="text-lg font-semibold tracking-tight">Ainda não há versão publicada</h2>
        <p className="text-sm text-pretty text-muted-foreground">
          O app para computador será liberado em breve. Enquanto isso, use o Spook no navegador.
        </p>
        <Button asChild>
          <Link to="/">Abrir no navegador</Link>
        </Button>
      </div>
    );
  }
  if (mobile) {
    return (
      <p className="flex max-w-xl items-start gap-2 rounded-xl border border-border bg-card p-4 text-sm text-pretty shadow-sm">
        <MonitorSmartphone className="mt-0.5 size-4 shrink-0 text-brand-text" aria-hidden />O app é
        para computador (Windows, macOS e Linux). No celular, abra o Spook no navegador.
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
              <Download aria-hidden /> Baixar para {recommended.title}
            </a>
          </Button>
          <p className="text-sm text-muted-foreground">
            Versão {release.version} · {KIND_LABEL[main.kind]} · {formatBytes(main.size)}
            {release.publishedAt ? ` · ${date.format(new Date(release.publishedAt))}` : ""}
          </p>
          {os === "macos" ? (
            <p className="text-xs text-muted-foreground">
              Escolhemos o Mac com chip Apple. Se o seu for Intel, use o cartão "macOS (Intel)"
              abaixo.
            </p>
          ) : null}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          Versão {release.version}. Escolha o seu sistema abaixo.
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
  const reason = error instanceof ReleaseError ? error.reason : "error";
  const text =
    reason === "rate-limit"
      ? "O GitHub limitou as consultas deste endereço por um tempo. Tente de novo em alguns minutos ou baixe direto na página de releases."
      : reason === "network"
        ? "Não foi possível falar com o GitHub. Verifique a internet e tente de novo."
        : "Não foi possível carregar a versão mais recente. Tente de novo ou baixe direto na página de releases.";
  return (
    <div
      role="alert"
      className="flex max-w-xl flex-col items-start gap-3 rounded-xl border border-border bg-card p-5 shadow-sm"
    >
      <ErrorIllustration className="h-28 w-auto" />
      <h2 className="text-lg font-semibold tracking-tight">Não deu para buscar a versão</h2>
      <p className="text-sm text-pretty text-muted-foreground">{text}</p>
      <div className="flex flex-wrap gap-2">
        <Button onClick={onRetry} loading={retrying}>
          <RotateCw aria-hidden /> Tentar de novo
        </Button>
        <Button asChild variant="outline">
          <a href={RELEASES_PAGE_URL} target="_blank" rel="noreferrer">
            Releases no GitHub <ExternalLink aria-hidden />
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
  const list = installersFor(release, target);
  return (
    <Card
      className={cn("h-full gap-3 py-4", highlighted && "border-brand-400 ring-1 ring-brand-400")}
      aria-label={target.title}
    >
      <div className="flex flex-col gap-0.5 px-4">
        <h3 className="flex items-center gap-2 font-semibold tracking-tight">
          {target.title}
          {highlighted ? (
            <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-medium text-brand-text">
              Recomendado
            </span>
          ) : null}
        </h3>
        <p className="text-xs text-pretty text-muted-foreground">{target.subtitle}</p>
        <p className="text-xs text-muted-foreground">
          Versão {release.version}
          {release.publishedAt ? ` · ${date.format(new Date(release.publishedAt))}` : ""}
        </p>
      </div>
      {list.length === 0 ? (
        <p className="px-4 text-sm text-muted-foreground">Ainda não disponível nesta versão.</p>
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
                  <Download aria-hidden /> {KIND_LABEL[i.kind]} · {formatBytes(i.size)}
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
  const [copied, setCopied] = useState(false);
  if (!installer.sha256) {
    return installer.checksumUrl ? (
      <a
        href={installer.checksumUrl}
        className="text-xs text-brand-text underline-offset-4 hover:underline"
      >
        Baixar o arquivo .sha256
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
      toast.error("Não foi possível copiar. Selecione o texto e copie à mão.");
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
        aria-label={`Copiar o SHA-256 de ${installer.name}`}
        onClick={() => void copy()}
      >
        {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      </Button>
    </div>
  );
}

function InstallHelp({ highlight }: { highlight: Os | null }) {
  const block = "rounded-xl border border-border bg-card shadow-sm";
  const summary =
    "flex min-h-11 cursor-pointer items-center justify-between gap-2 rounded-xl px-4 py-3 text-sm font-semibold hover:bg-accent";
  const code = "rounded bg-secondary px-1.5 py-0.5 font-mono text-xs break-all";
  return (
    <section aria-labelledby="dl-help" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id="dl-help" className="text-xl font-semibold tracking-tight">
          Como instalar
        </h2>
        <p className="max-w-2xl text-sm text-pretty text-muted-foreground">
          O instalador do Spook <strong>não tem assinatura de código</strong> da Microsoft nem da
          Apple (isso exige uma conta paga). Por isso o sistema mostra um aviso na primeira
          abertura; o app é o mesmo e você pode conferir o SHA-256 do arquivo antes de abrir.
        </p>
      </div>
      <details className={block} open={highlight === "windows"}>
        <summary className={summary}>Windows (SmartScreen)</summary>
        <ol className="flex list-decimal flex-col gap-1.5 px-8 pb-4 text-sm text-pretty">
          <li>
            Abra o arquivo .exe baixado. A instalação é só para o seu usuário, sem pedir
            administrador.
          </li>
          <li>
            Se aparecer <q>O Windows protegeu o computador</q>, clique em{" "}
            <strong>Mais informações</strong> e depois em <strong>Executar assim mesmo</strong>.
          </li>
          <li>
            Para conferir o arquivo: no PowerShell,{" "}
            <code className={code}>Get-FileHash .\Spook-*.exe</code> e compare com o SHA-256 acima.
          </li>
        </ol>
      </details>
      <details className={block} open={highlight === "macos"}>
        <summary className={summary}>macOS (Gatekeeper)</summary>
        <ol className="flex list-decimal flex-col gap-1.5 px-8 pb-4 text-sm text-pretty">
          <li>
            Abra o .dmg e arraste o <strong>Spook</strong> para a pasta Aplicativos.
          </li>
          <li>
            Na primeira vez o macOS pode dizer que o app não pode ser aberto. Abra{" "}
            <strong>Ajustes do Sistema, Privacidade e Segurança</strong> e clique em{" "}
            <strong>Abrir mesmo assim</strong> (em versões mais antigas: botão direito no Spook,
            Abrir).
          </li>
          <li>
            Se disser que o app está <q>danificado</q>, remova a quarentena no Terminal:{" "}
            <code className={code}>xattr -dr com.apple.quarantine /Applications/Spook.app</code>
          </li>
          <li>
            Para conferir o arquivo: <code className={code}>shasum -a 256 Spook-*.dmg</code>.
          </li>
        </ol>
      </details>
      <details className={block} open={highlight === "linux"}>
        <summary className={summary}>Linux</summary>
        <ol className="flex list-decimal flex-col gap-1.5 px-8 pb-4 text-sm text-pretty">
          <li>
            <strong>AppImage</strong> (recomendado, atualiza sozinho):{" "}
            <code className={code}>chmod +x Spook-*.AppImage &amp;&amp; ./Spook-*.AppImage</code>
          </li>
          <li>
            <strong>.deb</strong> (Ubuntu e Debian):{" "}
            <code className={code}>sudo apt install ./Spook-*.deb</code>. Para atualizar, baixe o
            novo .deb aqui.
          </li>
          <li>Pede glibc 2.39 ou mais nova (Ubuntu 24.04+, Debian 13+, Fedora 40+).</li>
          <li>
            Para conferir o arquivo: <code className={code}>sha256sum Spook-*</code>.
          </li>
        </ol>
      </details>
    </section>
  );
}
