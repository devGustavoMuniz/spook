import { Download, RefreshCw, RotateCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Hint, SettingsGroup } from "@/features/settings/ui";
import { UpdateProgress } from "./update-progress";
import { updater as appUpdater, progressPercent, type Updater } from "./updater";

const time = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });

/** `/settings/app` (só desktop): versão instalada, "Verificar atualizações", progresso e "Reiniciar para atualizar". */
export function UpdatesSection({ updater = appUpdater }: { updater?: Updater }) {
  const status = updater.useStore((s) => s.status);
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    updater
      .currentVersion()
      .then((v) => alive && setVersion(v))
      .catch(() => alive && setVersion(null));
    return () => {
      alive = false;
    };
  }, [updater]);

  const busy = status.kind === "checking" || status.kind === "downloading";
  return (
    <SettingsGroup
      icon={Download}
      title="Atualizações"
      description="O Spook procura versões novas ao abrir e a cada 6 horas, baixa em segundo plano e só reinicia quando você pedir."
    >
      <p className="text-sm">
        Versão instalada:{" "}
        <strong className="font-semibold">{version ? `v${version}` : "desconhecida"}</strong>
      </p>
      <div aria-live="polite" className="flex flex-col gap-2 text-sm">
        {status.kind === "checking" ? <p>Verificando atualizações…</p> : null}
        {status.kind === "uptodate" ? (
          <p>
            Você está na versão mais recente (verificado às{" "}
            {time.format(new Date(status.checkedAt))}
            ).
          </p>
        ) : null}
        {status.kind === "available" ? <p>Nova versão {status.version} encontrada.</p> : null}
        {status.kind === "downloading" ? (
          <>
            <p>
              Baixando a versão {status.version}
              {progressPercent(status.downloaded, status.total) === null
                ? "…"
                : `: ${progressPercent(status.downloaded, status.total)}%`}
            </p>
            <UpdateProgress downloaded={status.downloaded} total={status.total} />
          </>
        ) : null}
        {status.kind === "ready" ? (
          <p>A versão {status.version} já foi baixada e está pronta para instalar.</p>
        ) : null}
        {status.kind === "error" ? (
          <p role="alert" className="text-destructive-text">
            {status.message}
          </p>
        ) : null}
        {status.kind === "idle" ? <Hint>Nenhuma verificação feita nesta sessão ainda.</Hint> : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {status.kind === "ready" ? (
          <Button onClick={() => void updater.requestRestart()}>
            <RotateCw aria-hidden /> Reiniciar para atualizar
          </Button>
        ) : null}
        {status.kind === "error" && status.phase === "download" ? (
          <Button onClick={() => void updater.download()}>Tentar de novo</Button>
        ) : null}
        <Button
          variant="outline"
          onClick={() => void updater.check({ manual: true })}
          loading={status.kind === "checking"}
          disabled={busy || status.kind === "ready"}
        >
          <RefreshCw aria-hidden /> Verificar atualizações
        </Button>
      </div>
    </SettingsGroup>
  );
}
