import { Headphones } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogHead,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { isTauri } from "@/desktop/runtime";
import {
  audioCapabilities,
  chooseAudioProcessing,
  chooseDevice,
  listDevices,
  supportsAudioProcessing,
} from "./controller";
import { loadAudioProcessing, loadDevicePrefs } from "./devices";
import type {
  AudioCapabilities,
  AudioProcessingOptions,
  AudioProcessingStatus,
  DeviceInfo,
  DeviceKind,
  NoiseSuppressionLevel,
} from "./engine";
import { MicTestSection } from "./mic-test-section";
import { useAudioStatusStore, useVoiceStore } from "./store";

const FIELDS: { kind: DeviceKind; label: string }[] = [
  { kind: "audioinput", label: "Microfone" },
  { kind: "audiooutput", label: "Alto-falante" },
  { kind: "videoinput", label: "Câmera" },
];

const AUDIO_SWITCHES: {
  key: "echoCancellation" | "autoGainControl";
  label: string;
  hint: string;
}[] = [
  {
    key: "echoCancellation",
    label: "Cancelamento de eco",
    hint: "Evita que os outros ouçam você de volta. Fones de ouvido evitam o eco de vez.",
  },
  {
    key: "autoGainControl",
    label: "Ajuste automático de volume",
    hint: "Mantém o volume da sua voz estável.",
  },
];

const NOISE_LEVELS: { value: NoiseSuppressionLevel; label: string; hint: string }[] = [
  {
    value: "off",
    label: "Desligada",
    hint: "Sua voz vai sem filtro. Melhor com microfone de estúdio.",
  },
  {
    value: "standard",
    label: "Padrão",
    hint: "Filtro embutido do navegador. Leve e bom para a maioria.",
  },
  {
    value: "strong",
    label: "Forte (IA)",
    hint: "Modelo de IA gratuito que remove teclado, ventilador e TV ao fundo. Usa mais processador.",
  },
];

/** O que está em efeito agora, em palavras simples (vai num `aria-live`). */
export function noiseStatusText(
  chosen: NoiseSuppressionLevel,
  status: AudioProcessingStatus | null,
): string {
  if (status?.state === "degraded")
    return status.reason ?? "A IA foi desativada. Usando o filtro Padrão.";
  if (chosen === "off") return "Desligada: sua voz não passa por nenhum filtro.";
  if (chosen === "standard") return "Padrão do navegador: filtro leve em uso.";
  if (status?.state === "loading") return "Carregando o modelo de IA (só na primeira vez)…";
  if (status?.state === "active")
    return status.load === "high"
      ? "Processando com IA, mas o computador está no limite: o áudio pode falhar."
      : "Processando com IA.";
  return "A IA liga quando o microfone for aberto na chamada.";
}

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
  const [caps, setCaps] = useState<AudioCapabilities>({ strongNoiseSuppression: false });
  const status = useAudioStatusStore((st) => st.status);
  const micOpenInCall = useVoiceStore((st) => st.status !== "idle" && !st.selfMute);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setChosen(loadDevicePrefs());
    setProcessing(loadAudioProcessing());
    setCanProcess(supportsAudioProcessing());
    setCaps(audioCapabilities());
    void Promise.all(FIELDS.map(async (f) => [f.kind, await listDevices(f.kind)] as const)).then(
      (entries) => alive && setDevices(Object.fromEntries(entries)),
    );
    return () => {
      alive = false;
    };
  }, [open]);

  // A IA foi rebaixada (sem suporte, falha ou lentidão): o controlador já gravou "Padrão"; a tela acompanha.
  useEffect(() => {
    if (status?.state === "degraded")
      setProcessing((p) => ({ ...p, noiseSuppression: status.level }));
  }, [status]);

  const update = (next: AudioProcessingOptions) => {
    setProcessing(next);
    void chooseAudioProcessing(next);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent flush className="max-h-[min(40rem,92svh)]">
        <DialogHead
          icon={Headphones}
          title="Dispositivos de áudio e vídeo"
          description={
            isTauri()
              ? "A escolha fica salva neste computador e vale na chamada em curso."
              : "A escolha fica salva neste navegador. Os nomes só aparecem depois que o navegador liberar o acesso ao microfone ou à câmera."
          }
        />
        <DialogBody>
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
            <section
              aria-labelledby="mic-quality-title"
              className="flex flex-col gap-3 border-t pt-3"
            >
              <h3 id="mic-quality-title" className="text-sm font-medium">
                Qualidade do microfone
              </h3>
              <fieldset className="flex flex-col gap-1.5">
                <legend className="mb-1 text-sm">Redução de ruído</legend>
                {NOISE_LEVELS.map(({ value, label, hint }) => {
                  const id = `noise-${value}`;
                  const unavailable = value === "strong" && !caps.strongNoiseSuppression;
                  return (
                    <label
                      key={value}
                      htmlFor={id}
                      className={`flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm has-[:checked]:border-primary has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring ${unavailable ? "cursor-not-allowed opacity-60" : ""}`}
                    >
                      <input
                        id={id}
                        type="radio"
                        name="noise-suppression"
                        value={value}
                        className="mt-1 accent-primary"
                        checked={processing.noiseSuppression === value}
                        disabled={unavailable}
                        aria-describedby={`${id}-hint`}
                        onChange={() => update({ ...processing, noiseSuppression: value })}
                      />
                      <span className="flex flex-col">
                        <span>
                          {label}
                          {unavailable && caps.strongUnavailableReason
                            ? ` (${caps.strongUnavailableReason})`
                            : ""}
                        </span>
                        <span id={`${id}-hint`} className="text-xs text-muted-foreground">
                          {hint}
                        </span>
                      </span>
                    </label>
                  );
                })}
                <p aria-live="polite" className="text-xs text-muted-foreground">
                  {noiseStatusText(processing.noiseSuppression, status)}
                </p>
              </fieldset>
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
                      onCheckedChange={(on) => update({ ...processing, [key]: on })}
                    />
                  </div>
                );
              })}
              {status?.gateError ? (
                <output className="block text-xs text-destructive-text">{status.gateError}</output>
              ) : null}
            </section>
          ) : null}
          {canProcess && (caps.inputSensitivity || caps.micTest) ? (
            <MicTestSection
              open={open}
              processing={processing}
              caps={caps}
              inCall={micOpenInCall}
              onChange={update}
            />
          ) : null}
        </DialogBody>
        <DialogActions>
          <DialogClose asChild>
            <Button>Concluído</Button>
          </DialogClose>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}
