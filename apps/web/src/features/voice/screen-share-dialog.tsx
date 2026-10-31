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
import { audioCapabilities, listDevices } from "./controller";
import { loadDevicePrefs, loadScreenSharePrefs } from "./devices";
import { outputLooksLikeHeadphones } from "./echo-risk";
import type { ScreenShareQuality } from "./engine";
import {
  estimateUplinkKbps,
  formatKbps,
  isHeavy,
  loadScreenQuality,
  presetIdOf,
  QUALITY_PRESETS,
  SCREEN_FPS,
  SCREEN_HEIGHTS,
} from "./screen-quality";

/** Qualidade: presets nomeados + opções avançadas, com a estimativa de banda e o aviso de custo. */
function QualityPicker({
  quality,
  onChange,
}: {
  quality: ScreenShareQuality;
  onChange: (q: ScreenShareQuality) => void;
}) {
  const presetId = presetIdOf(quality);
  const kbps = estimateUplinkKbps(quality);
  const set = (patch: Partial<ScreenShareQuality>) => {
    const { maxBitrateKbps: _drop, ...rest } = { ...quality, ...patch };
    onChange(rest);
  };
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1 text-sm font-medium">Qualidade</legend>
      {QUALITY_PRESETS.map((p) => {
        const id = `screen-quality-${p.id}`;
        return (
          <label
            key={p.id}
            htmlFor={id}
            className="flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm has-[:checked]:border-primary has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
          >
            <input
              id={id}
              type="radio"
              name="screen-quality"
              className="mt-1 accent-primary"
              checked={presetId === p.id}
              aria-describedby={`${id}-hint`}
              onChange={() => onChange({ ...p.quality })}
            />
            <span className="flex flex-col">
              <span>{p.label}</span>
              <span id={`${id}-hint`} className="text-xs text-muted-foreground">
                {p.hint}
              </span>
            </span>
          </label>
        );
      })}
      <details className="rounded-md border px-3 py-2 text-sm" open={presetId === null}>
        <summary className="cursor-pointer">
          Opções avançadas{presetId === null ? " (personalizada)" : ""}
        </summary>
        <div className="mt-2 grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-xs" htmlFor="screen-quality-height">
            Resolução
            <select
              id="screen-quality-height"
              value={quality.height}
              onChange={(e) =>
                set({ height: Number(e.target.value) as ScreenShareQuality["height"] })
              }
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            >
              {SCREEN_HEIGHTS.map((h) => (
                <option key={h} value={h}>
                  {h}p
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs" htmlFor="screen-quality-fps">
            Quadros por segundo
            <select
              id="screen-quality-fps"
              value={quality.fps}
              onChange={(e) => set({ fps: Number(e.target.value) as ScreenShareQuality["fps"] })}
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            >
              {SCREEN_FPS.map((f) => (
                <option key={f} value={f}>
                  {f} fps
                </option>
              ))}
            </select>
          </label>
          <fieldset className="col-span-2 flex flex-col gap-1">
            <legend className="mb-1 text-xs">Prioridade quando a rede aperta</legend>
            {(
              [
                ["detail", "Priorizar nitidez", "mantém a resolução e baixa os quadros"],
                ["motion", "Priorizar fluidez", "mantém os quadros e baixa a resolução"],
              ] as const
            ).map(([value, label, hint]) => (
              <label key={value} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="screen-priority"
                  className="accent-primary"
                  checked={quality.priority === value}
                  onChange={() => set({ priority: value })}
                />
                <span>
                  {label} <span className="text-xs text-muted-foreground">({hint})</span>
                </span>
              </label>
            ))}
          </fieldset>
        </div>
      </details>
      <p className="text-xs text-muted-foreground">
        Banda de subida estimada: até {formatKbps(kbps)} por espectador no pior caso (o uso real
        costuma ser menor).
      </p>
      {isHeavy(quality) ? (
        <output className="block rounded-md border border-destructive/40 px-3 py-2 text-xs">
          Qualidade acima do padrão: gasta mais processador e internet de quem transmite e mais
          banda do servidor, que é pequeno. Se a chamada engasgar, volte para Nitidez 1080p 15 fps.
        </output>
      ) : null}
    </fieldset>
  );
}

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
  onConfirm: (opts: { audio: boolean; quality?: ScreenShareQuality }) => void;
}) {
  const [audio, setAudio] = useState(false);
  const [quality, setQuality] = useState(loadScreenQuality);
  const [headphones, setHeadphones] = useState<boolean | null>(null);
  // O app desktop ainda não captura o áudio do sistema: sem a opção, também não há laço de eco por compartilhar.
  const caps = audioCapabilities();
  const noSystemAudio = caps.screenShareAudio === false;
  const canTuneQuality = caps.screenShareQuality === true;

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setAudio(loadScreenSharePrefs().audio);
    setQuality(loadScreenQuality());
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
                Sua saída de áudio parece ser uma caixa de som. Com áudio compartilhado, use fones
                para evitar eco.
              </output>
            ) : null}
          </>
        )}
        {canTuneQuality ? (
          <QualityPicker quality={quality} onChange={setQuality} />
        ) : (
          <p className="text-xs text-muted-foreground">
            A qualidade da imagem é automática neste app: ainda não dá para escolher resolução ou
            quadros por segundo.
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            onClick={() => {
              onOpenChange(false);
              onConfirm(
                canTuneQuality
                  ? { audio: audio && !noSystemAudio, quality }
                  : { audio: audio && !noSystemAudio },
              );
            }}
          >
            Compartilhar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
