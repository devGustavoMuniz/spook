import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { isTauri } from "@/desktop/runtime";
import {
  chooseAudioProcessing,
  chooseDevice,
  listDevices,
  supportsAudioProcessing,
} from "./controller";
import { loadAudioProcessing, loadDevicePrefs } from "./devices";
import type { AudioProcessingOptions, DeviceInfo, DeviceKind } from "./engine";

const FIELDS: { kind: DeviceKind; label: string }[] = [
  { kind: "audioinput", label: "Microfone" },
  { kind: "audiooutput", label: "Alto-falante" },
  { kind: "videoinput", label: "Câmera" },
];

const AUDIO_SWITCHES: { key: keyof AudioProcessingOptions; label: string; hint: string }[] = [
  {
    key: "echoCancellation",
    label: "Cancelamento de eco",
    hint: "Evita que os outros ouçam você de volta quando está sem fone.",
  },
  {
    key: "noiseSuppression",
    label: "Redução de ruído",
    hint: "Reduz ventilador, teclado e ruído de fundo.",
  },
  {
    key: "autoGainControl",
    label: "Ajuste automático de volume",
    hint: "Mantém o volume da sua voz estável.",
  },
];

/** Seletor de microfone, alto-falante e câmera; a escolha fica no navegador e vale na chamada em curso. */
export function DeviceDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [devices, setDevices] = useState<Partial<Record<DeviceKind, DeviceInfo[]>>>({});
  const [chosen, setChosen] = useState(loadDevicePrefs);
  const [processing, setProcessing] = useState(loadAudioProcessing);
  const [canProcess, setCanProcess] = useState(false);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setChosen(loadDevicePrefs());
    setProcessing(loadAudioProcessing());
    setCanProcess(supportsAudioProcessing());
    void Promise.all(FIELDS.map(async (f) => [f.kind, await listDevices(f.kind)] as const)).then(
      (entries) => alive && setDevices(Object.fromEntries(entries)),
    );
    return () => {
      alive = false;
    };
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Dispositivos de áudio e vídeo</DialogTitle>
          <DialogDescription>
            {isTauri()
              ? "A escolha fica salva neste computador e vale na chamada em curso."
              : "A escolha fica salva neste navegador. Os nomes só aparecem depois que o navegador liberar o acesso ao microfone ou à câmera."}
          </DialogDescription>
        </DialogHeader>
        {FIELDS.map(({ kind, label }) => {
          const list = devices[kind] ?? [];
          const id = `device-${kind}`;
          return (
            <div key={kind} className="flex flex-col gap-1.5">
              <label htmlFor={id} className="text-sm font-medium">
                {label}
              </label>
              <select
                id={id}
                value={chosen[kind] ?? ""}
                onChange={(e) => {
                  setChosen((c) => ({ ...c, [kind]: e.target.value || undefined }));
                  void chooseDevice(kind, e.target.value);
                }}
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="">Padrão do sistema</option>
                {list.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))}
              </select>
            </div>
          );
        })}
        {canProcess ? (
          <fieldset className="flex flex-col gap-2 border-t pt-3">
            <legend className="mb-1 text-sm font-medium">Qualidade do microfone</legend>
            {AUDIO_SWITCHES.map(({ key, label, hint }) => {
              const id = `audio-processing-${key}`;
              return (
                <div key={key} className="flex items-center justify-between gap-3">
                  <label htmlFor={id} className="flex flex-col text-sm">
                    <span>{label}</span>
                    <span className="text-xs text-muted-foreground">{hint}</span>
                  </label>
                  <Switch
                    id={id}
                    checked={processing[key]}
                    onCheckedChange={(on) => {
                      const next = { ...processing, [key]: on };
                      setProcessing(next);
                      void chooseAudioProcessing(next);
                    }}
                  />
                </div>
              );
            })}
          </fieldset>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
