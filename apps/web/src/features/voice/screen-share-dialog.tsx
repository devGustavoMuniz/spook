import { ScreenShare } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogHead,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { useOpenNitro } from "@/features/nitro/use-open-nitro";
import { usePlan } from "@/features/nitro/use-plan";
import { useT } from "@/i18n";
import { type AppAudioPrefs, buildAppAudioOptions, loadAppAudioPrefs } from "./app-audio";
import { audioCapabilities, listDevices } from "./controller";
import { loadDevicePrefs, loadScreenSharePrefs } from "./devices";
import { outputLooksLikeHeadphones } from "./echo-risk";
import type { AppAudioOptions, ScreenShareQuality } from "./engine";
import { clampScreenChoice, loadScreenChoice, qualityOf } from "./screen-quality";
import { ScreenShareAppAudio } from "./screen-share-app-audio";
import { ScreenQualityFields } from "./screen-share-fields";

/**
 * Antes de abrir o seletor de tela do navegador/SO, como no Discord: resolução e taxa de quadros, se o áudio vai
 * junto e se o canal vê uma prévia (miniatura) da tela. O áudio começa DESLIGADO porque o som da tela/janela costuma
 * incluir a voz dos outros da chamada, que se ouviriam de volta (eco); a prévia começa LIGADA.
 */
export function ScreenShareDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (opts: {
    audio: boolean;
    quality?: ScreenShareQuality;
    preview?: boolean;
    /** Só no desktop (seção "Configurações avançadas"): o que compartilhar de áudio e os volumes. */
    appAudio?: AppAudioOptions;
  }) => void;
}) {
  const { t } = useT();
  const [audio, setAudio] = useState(false);
  const [preview, setPreview] = useState(true);
  const plan = usePlan();
  const openNitro = useOpenNitro();
  const [choice, setChoice] = useState(() => clampScreenChoice(loadScreenChoice(), plan.limits));
  const [headphones, setHeadphones] = useState<boolean | null>(null);
  const [appPrefs, setAppPrefs] = useState<AppAudioPrefs>(() => loadAppAudioPrefs());
  // O motor diz (ao listar os aplicativos) se este computador consegue capturar áudio por aplicativo.
  const [appSupported, setAppSupported] = useState(true);
  // O app desktop ainda não captura o áudio do sistema: sem a opção, também não há laço de eco por compartilhar.
  const caps = audioCapabilities();
  // Desktop: o áudio é por aplicativo e mora nas "Configurações avançadas" (o interruptor simples não existe).
  const hasAppAudio = caps.screenShareAppAudio === true;
  const noSystemAudio = caps.screenShareAudio === false && !hasAppAudio;
  const canTuneQuality = caps.screenShareQuality === true;
  // O desktop não consegue capturar um quadro da tela para a miniatura.
  const canPreview = caps.screenSharePreview !== false;

  // Dentro do efeito só os números importam (uma lista nova de limites por render não deve refazê-lo).
  const limits = plan.limits;
  const maxHeight = limits.screen_max_height;
  const maxFps = limits.screen_max_fps;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `limits` entra só pelos dois tetos acima
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const prefs = loadScreenSharePrefs();
    setAudio(prefs.audio);
    setPreview(prefs.preview);
    setAppPrefs(loadAppAudioPrefs());
    setChoice(clampScreenChoice(loadScreenChoice(), limits));
    void listDevices("audiooutput").then((outs) => {
      if (alive) setHeadphones(outputLooksLikeHeadphones(outs, loadDevicePrefs().audiooutput));
    });
    return () => {
      alive = false;
    };
  }, [open, maxHeight, maxFps]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent flush className="max-h-[min(40rem,92svh)]">
        <DialogHead
          icon={ScreenShare}
          title={t("voice.share.title")}
          description={t("voice.share.description")}
        />
        <DialogBody>
          {canTuneQuality ? (
            <ScreenQualityFields
              idPrefix="screen-share"
              choice={choice}
              onChange={setChoice}
              onUpgrade={() => {
                onOpenChange(false);
                openNitro();
              }}
            />
          ) : (
            <p className="text-xs text-muted-foreground">{t("voice.share.autoQuality")}</p>
          )}
          {hasAppAudio ? null : noSystemAudio ? (
            <p className="text-sm">{t("voice.share.noSystemAudio")}</p>
          ) : (
            <>
              <div className="flex items-center justify-between gap-3">
                <label htmlFor="screen-share-audio" className="flex flex-col text-sm">
                  <span>{t("voice.share.includeAudio")}</span>
                  <span className="text-xs text-muted-foreground">
                    {t("voice.share.audioHint")}
                  </span>
                </label>
                <Switch id="screen-share-audio" checked={audio} onCheckedChange={setAudio} />
              </div>
              <p className="text-xs text-muted-foreground">
                {t("voice.share.tabTipBefore")}
                <strong>{t("voice.share.tabTipStrong")}</strong>
                {t("voice.share.tabTipAfter")}
              </p>
              {audio && headphones === false ? (
                <output className="block rounded-md border border-destructive/40 px-3 py-2 text-xs">
                  {t("voice.share.speakerWarning")}
                </output>
              ) : null}
            </>
          )}
          <div className="flex items-start gap-3">
            <input
              id="screen-share-preview"
              type="checkbox"
              className="mt-1 size-4 shrink-0 accent-primary disabled:cursor-not-allowed"
              checked={canPreview && preview}
              disabled={!canPreview}
              aria-describedby="screen-share-preview-hint"
              onChange={(e) => setPreview(e.target.checked)}
            />
            <div className="flex flex-col text-sm">
              <label htmlFor="screen-share-preview">{t("voice.share.preview")}</label>
              <span id="screen-share-preview-hint" className="text-xs text-muted-foreground">
                {canPreview ? t("voice.share.previewHint") : t("voice.share.previewUnavailable")}
              </span>
            </div>
          </div>
          {hasAppAudio ? (
            <ScreenShareAppAudio
              audio={audio}
              onAudioChange={setAudio}
              prefs={appPrefs}
              onPrefsChange={setAppPrefs}
              onSupportChange={setAppSupported}
            />
          ) : null}
        </DialogBody>
        <DialogActions>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("voice.cancel")}
          </Button>
          <Button
            onClick={() => {
              onOpenChange(false);
              const audioOn = audio && (hasAppAudio ? appSupported : !noSystemAudio);
              onConfirm({
                audio: audioOn,
                ...(hasAppAudio && audioOn ? { appAudio: buildAppAudioOptions(appPrefs) } : {}),
                ...(canTuneQuality
                  ? { quality: qualityOf(clampScreenChoice(choice, limits)) }
                  : {}),
                ...(canPreview ? { preview } : {}),
              });
            }}
          >
            {t("voice.share.confirm")}
          </Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}
