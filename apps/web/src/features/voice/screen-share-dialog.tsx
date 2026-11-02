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
import { audioCapabilities, listDevices } from "./controller";
import { loadDevicePrefs, loadScreenSharePrefs } from "./devices";
import { outputLooksLikeHeadphones } from "./echo-risk";
import type { ScreenShareQuality } from "./engine";
import { loadScreenChoice, qualityOf } from "./screen-quality";
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
  onConfirm: (opts: { audio: boolean; quality?: ScreenShareQuality; preview?: boolean }) => void;
}) {
  const [audio, setAudio] = useState(false);
  const [preview, setPreview] = useState(true);
  const [choice, setChoice] = useState(loadScreenChoice);
  const [headphones, setHeadphones] = useState<boolean | null>(null);
  // O app desktop ainda não captura o áudio do sistema: sem a opção, também não há laço de eco por compartilhar.
  const caps = audioCapabilities();
  const noSystemAudio = caps.screenShareAudio === false;
  const canTuneQuality = caps.screenShareQuality === true;
  // O desktop não consegue capturar um quadro da tela para a miniatura.
  const canPreview = caps.screenSharePreview !== false;

  useEffect(() => {
    if (!open) return;
    let alive = true;
    const prefs = loadScreenSharePrefs();
    setAudio(prefs.audio);
    setPreview(prefs.preview);
    setChoice(loadScreenChoice());
    void listDevices("audiooutput").then((outs) => {
      if (alive) setHeadphones(outputLooksLikeHeadphones(outs, loadDevicePrefs().audiooutput));
    });
    return () => {
      alive = false;
    };
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent flush className="max-h-[min(40rem,92svh)]">
        <DialogHead
          icon={ScreenShare}
          title="Compartilhar tela"
          description="Escolha a qualidade e o que vai junto com a imagem."
        />
        <DialogBody>
          {canTuneQuality ? (
            <ScreenQualityFields idPrefix="screen-share" choice={choice} onChange={setChoice} />
          ) : (
            <p className="text-xs text-muted-foreground">
              A qualidade da imagem é automática neste app: ainda não dá para escolher resolução ou
              quadros por segundo.
            </p>
          )}
          {noSystemAudio ? (
            <p className="text-sm">
              O app de computador ainda não envia o som do computador na tela compartilhada, só a
              imagem. Por isso não há eco por compartilhar. Quem assiste não ouvirá o vídeo ou a
              música que você mostrar.
            </p>
          ) : (
            <>
              <div className="flex items-center justify-between gap-3">
                <label htmlFor="screen-share-audio" className="flex flex-col text-sm">
                  <span>Incluir áudio</span>
                  <span className="text-xs text-muted-foreground">
                    Desligado por padrão: o som do computador pode carregar a voz dos outros e eles
                    se ouvirão de volta (eco).
                  </span>
                </label>
                <Switch id="screen-share-audio" checked={audio} onCheckedChange={setAudio} />
              </div>
              <p className="text-xs text-muted-foreground">
                Para mostrar um vídeo ou uma música sem eco, compartilhe uma <strong>aba</strong> do
                navegador com áudio: só o som daquela aba vai, sem a voz da chamada. Ao compartilhar
                a tela inteira ou uma janela com áudio, use fones de ouvido.
              </p>
              {audio && headphones === false ? (
                <output className="block rounded-md border border-destructive/40 px-3 py-2 text-xs">
                  Sua saída de áudio parece ser uma caixa de som. Com áudio compartilhado, use fones
                  para evitar eco.
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
              <label htmlFor="screen-share-preview">Mostrar prévia para o canal</label>
              <span id="screen-share-preview-hint" className="text-xs text-muted-foreground">
                {canPreview
                  ? "Quem está no servidor vê uma miniatura da sua tela antes de entrar na transmissão. Desligue para conteúdo sensível."
                  : "Indisponível no app para computador."}
              </span>
            </div>
          </div>
        </DialogBody>
        <DialogActions>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            onClick={() => {
              onOpenChange(false);
              onConfirm({
                audio: audio && !noSystemAudio,
                ...(canTuneQuality ? { quality: qualityOf(choice) } : {}),
                ...(canPreview ? { preview } : {}),
              });
            }}
          >
            Compartilhar
          </Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}
