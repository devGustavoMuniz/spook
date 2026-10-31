import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { listDevices } from "./controller";
import { loadDevicePrefs, loadScreenSharePrefs } from "./devices";
import { outputLooksLikeHeadphones } from "./echo-risk";

/**
 * Antes de abrir o seletor de tela do navegador/SO: pergunta se o áudio vai junto. Começa DESLIGADO porque o
 * áudio da tela/janela costuma incluir a voz dos outros da chamada, que se ouviriam de volta (eco).
 */
export function ScreenShareDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (opts: { audio: boolean }) => void;
}) {
  const [audio, setAudio] = useState(false);
  const [headphones, setHeadphones] = useState<boolean | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setAudio(loadScreenSharePrefs().audio);
    void listDevices("audiooutput").then((outs) => {
      if (alive) setHeadphones(outputLooksLikeHeadphones(outs, loadDevicePrefs().audiooutput));
    });
    return () => {
      alive = false;
    };
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Compartilhar tela</DialogTitle>
          <DialogDescription>
            Escolha se o som do que você vai mostrar também vai para a chamada.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-between gap-3">
          <label htmlFor="screen-share-audio" className="flex flex-col text-sm">
            <span>Incluir áudio</span>
            <span className="text-xs text-muted-foreground">
              Desligado por padrão: o som do computador pode carregar a voz dos outros e eles se
              ouvirão de volta (eco).
            </span>
          </label>
          <Switch id="screen-share-audio" checked={audio} onCheckedChange={setAudio} />
        </div>
        <p className="text-xs text-muted-foreground">
          Para mostrar um vídeo ou uma música sem eco, compartilhe uma <strong>aba</strong> do
          navegador com áudio: só o som daquela aba vai, sem a voz da chamada. Ao compartilhar a
          tela inteira ou uma janela com áudio, use fones de ouvido.
        </p>
        {audio && headphones === false ? (
          <output className="block rounded-md border border-destructive/40 px-3 py-2 text-xs">
            Sua saída de áudio parece ser uma caixa de som. Com áudio compartilhado, use fones para
            evitar eco.
          </output>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            onClick={() => {
              onOpenChange(false);
              onConfirm({ audio });
            }}
          >
            Compartilhar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
