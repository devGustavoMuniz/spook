import { useEffect, useRef, useState } from "react";
import { LogoMark } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { t, useT } from "@/i18n";
import { UpdateProgress } from "./update-progress";
import { updater as appUpdater, progressPercent, type Updater, type UpdateStatus } from "./updater";

/** Tempo máximo da tela de abertura quando não há atualização. */
export const SPLASH_MAX_MS = 1500;
/** Tempo mínimo (evita um piscar quando a verificação responde na hora). */
export const SPLASH_MIN_MS = 600;
const FADE_MS = 200;

/** Texto principal da tela de abertura para cada estado da atualização. */
export function splashText(status: UpdateStatus): string {
  switch (status.kind) {
    case "available":
      return t("settings.splash.available", { version: status.version });
    case "downloading": {
      const pct = progressPercent(status.downloaded, status.total);
      return pct === null
        ? t("settings.updates.downloadingUnknown", { version: status.version })
        : t("settings.updates.downloading", { version: status.version, percent: pct });
    }
    case "ready":
      return t("settings.splash.restarting");
    case "error":
      return status.message;
    default:
      return t("settings.updates.checking");
  }
}

/**
 * Tela de abertura do app desktop, por cima do app que já carrega por baixo: marca + "Verificando atualizações…".
 * Some em até 1,5 s se não houver atualização (ou se a internet estiver fora). Se houver, mostra o download e a
 * pessoa pode seguir usando o app; terminando o download ainda na abertura, reinicia sozinha (não há chamada ainda).
 */
export function UpdateSplash({ updater = appUpdater }: { updater?: Updater }) {
  const { t } = useT();
  const status = updater.useStore((s) => s.status);
  const [hiding, setHiding] = useState(false);
  const [gone, setGone] = useState(false);
  const startedAt = useRef(Date.now());
  const restarted = useRef(false);
  const sawChecking = useRef(false);

  // Verificação da abertura (silenciosa em caso de erro). Em StrictMode roda duas vezes; o controlador ignora a repetida.
  useEffect(() => {
    void updater.check();
  }, [updater]);

  // Limite de 1,5 s: passou disso sem update encontrado, segue para o app (a verificação continua em segundo plano).
  useEffect(() => {
    const t = setTimeout(() => {
      const k = updater.getStatus().kind;
      if (k !== "available" && k !== "downloading" && k !== "ready" && k !== "error")
        setHiding(true);
    }, SPLASH_MAX_MS);
    return () => clearTimeout(t);
  }, [updater]);

  // Verificação terminou sem novidade (ou falhou em silêncio, p. ex. sem internet): some, respeitando o tempo mínimo.
  useEffect(() => {
    if (status.kind === "checking") sawChecking.current = true;
    const finished = status.kind === "uptodate" || (status.kind === "idle" && sawChecking.current);
    if (!finished) return;
    const wait = Math.max(0, SPLASH_MIN_MS - (Date.now() - startedAt.current));
    const t = setTimeout(() => setHiding(true), wait);
    return () => clearTimeout(t);
  }, [status.kind]);

  // Baixou ainda na abertura: aplica agora.
  useEffect(() => {
    if (status.kind === "ready" && !restarted.current && !hiding) {
      restarted.current = true;
      void updater.requestRestart();
    }
  }, [status.kind, hiding, updater]);

  useEffect(() => {
    if (!hiding) return;
    const t = setTimeout(() => setGone(true), FADE_MS);
    return () => clearTimeout(t);
  }, [hiding]);

  if (gone) return null;
  const working = status.kind === "available" || status.kind === "downloading";
  const failed = status.kind === "error";
  return (
    <div
      data-testid="update-splash"
      className={`fixed inset-0 z-[var(--z-toast)] grid place-items-center bg-brand-glow px-6 transition-opacity duration-200 motion-reduce:transition-none ${hiding ? "pointer-events-none opacity-0" : "opacity-100"}`}
    >
      <div className="flex w-full max-w-xs flex-col items-center gap-4 text-center">
        <div className="animate-float motion-reduce:animate-none">
          <LogoMark size={96} glow alt="Spook" />
        </div>
        <output aria-live="polite" className="block text-sm font-medium text-balance">
          {splashText(status)}
        </output>
        {working && status.kind === "downloading" ? (
          <UpdateProgress downloaded={status.downloaded} total={status.total} />
        ) : null}
        {working || failed ? (
          <Button variant="outline" size="sm" onClick={() => setHiding(true)}>
            {t("settings.splash.continue")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
