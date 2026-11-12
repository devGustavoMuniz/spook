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
import { type MessageKey, t, useT } from "@/i18n";
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

const FIELDS: { kind: DeviceKind; labelKey: MessageKey }[] = [
  { kind: "audioinput", labelKey: "voice.devmenu.mic.title" },
  { kind: "audiooutput", labelKey: "voice.devmenu.speaker.title" },
  { kind: "videoinput", labelKey: "voice.devdlg.camera" },
];

const AUDIO_SWITCHES: {
  key: "echoCancellation" | "autoGainControl";
  labelKey: MessageKey;
  hintKey: MessageKey;
}[] = [
  { key: "echoCancellation", labelKey: "voice.audio.echo.label", hintKey: "voice.audio.echo.hint" },
  { key: "autoGainControl", labelKey: "voice.audio.agc.label", hintKey: "voice.audio.agc.hint" },
];

const NOISE_LEVELS: { value: NoiseSuppressionLevel; labelKey: MessageKey; hintKey: MessageKey }[] =
  [
    { value: "off", labelKey: "voice.noise.off.label", hintKey: "voice.noise.off.hint" },
    {
      value: "standard",
      labelKey: "voice.noise.standard.label",
      hintKey: "voice.noise.standard.hint",
    },
    { value: "strong", labelKey: "voice.noise.strong.label", hintKey: "voice.noise.strong.hint" },
    { value: "max", labelKey: "voice.noise.max.label", hintKey: "voice.noise.max.hint" },
  ];

/** O "Máximo" (IA pesada) só aparece onde a engine declara a capacidade (hoje, só o desktop). */
export function visibleNoiseLevels<T extends { value: NoiseSuppressionLevel }>(
  levels: readonly T[],
  caps: { maxNoiseSuppression?: boolean },
): T[] {
  return levels.filter((l) => l.value !== "max" || caps.maxNoiseSuppression === true);
}

/** O que está em efeito agora, em palavras simples (vai num `aria-live`). */
export function noiseStatusText(
  chosen: NoiseSuppressionLevel,
  status: AudioProcessingStatus | null,
): string {
  if (status?.state === "degraded") return status.reason ?? t("voice.noise.status.degraded");
  if (chosen === "off") return t("voice.noise.status.off");
  if (chosen === "standard") return t("voice.noise.status.standard");
  if (chosen === "max") return t("voice.noise.status.max");
  if (status?.state === "loading") return t("voice.noise.status.loading");
  if (status?.state === "active")
    return status.load === "high" ? t("voice.noise.status.high") : t("voice.noise.status.active");
  return t("voice.noise.status.idle");
}

/** Seletor de microfone, alto-falante e câmera; a escolha fica no navegador e vale na chamada em curso. */
export function DeviceDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useT();
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
          title={t("voice.devdlg.title")}
          description={isTauri() ? t("voice.devdlg.descDesktop") : t("voice.devdlg.descWeb")}
        />
        <DialogBody>
          {FIELDS.map(({ kind, labelKey }) => {
            const list = devices[kind] ?? [];
            const id = `device-${kind}`;
            return (
              <div key={kind} className="flex flex-col gap-1.5">
                <label htmlFor={id} className="text-sm font-medium">
                  {t(labelKey)}
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
                  <option value="">{t("voice.device.default")}</option>
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
                {t("voice.devdlg.quality")}
              </h3>
              <fieldset className="flex flex-col gap-1.5">
                <legend className="mb-1 text-sm">{t("voice.devdlg.noise")}</legend>
                {visibleNoiseLevels(NOISE_LEVELS, caps).map(({ value, labelKey, hintKey }) => {
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
                          {t(labelKey)}
                          {unavailable && caps.strongUnavailableReason
                            ? t("voice.noise.unavailable", { reason: caps.strongUnavailableReason })
                            : ""}
                        </span>
                        <span id={`${id}-hint`} className="text-xs text-muted-foreground">
                          {t(hintKey)}
                        </span>
                      </span>
                    </label>
                  );
                })}
                <p aria-live="polite" className="text-xs text-muted-foreground">
                  {noiseStatusText(processing.noiseSuppression, status)}
                </p>
              </fieldset>
              {AUDIO_SWITCHES.map(({ key, labelKey, hintKey }) => {
                const id = `audio-processing-${key}`;
                return (
                  <div key={key} className="flex items-center justify-between gap-3">
                    <label htmlFor={id} className="flex flex-col text-sm">
                      <span>{t(labelKey)}</span>
                      <span className="text-xs text-muted-foreground">{t(hintKey)}</span>
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
            <Button>{t("voice.devdlg.done")}</Button>
          </DialogClose>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}
