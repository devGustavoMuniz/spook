import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { chooseDevice, listDevices } from "./controller";
import { loadDevicePrefs } from "./devices";
import type { DeviceInfo, DeviceKind } from "./engine";

const FIELDS: { kind: DeviceKind; label: string }[] = [
  { kind: "audioinput", label: "Microfone" },
  { kind: "audiooutput", label: "Alto-falante" },
  { kind: "videoinput", label: "Câmera" },
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

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setChosen(loadDevicePrefs());
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
            A escolha fica salva neste navegador. Os nomes só aparecem depois que o navegador
            liberar o acesso ao microfone ou à câmera.
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
      </DialogContent>
    </Dialog>
  );
}
