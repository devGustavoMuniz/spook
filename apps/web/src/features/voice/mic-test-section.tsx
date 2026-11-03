import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { type MessageKey, t, useT } from "@/i18n";
import {
  cancelMicTest,
  micTestBlockedByCall,
  runMicTest,
  startInputMonitor,
  stopInputMonitor,
} from "./controller";
import { SENSITIVITY_RANGE } from "./devices";
import type {
  AudioCapabilities,
  AudioProcessingOptions,
  InputSensitivity,
  MicTestState,
} from "./engine";
import { MicMeter } from "./mic-meter";
import { useInputLevelStore, useMicTestStore } from "./store";

const MODES: { value: InputSensitivity["mode"]; labelKey: MessageKey; hintKey: MessageKey }[] = [
  { value: "off", labelKey: "voice.sens.off.label", hintKey: "voice.sens.off.hint" },
  { value: "auto", labelKey: "voice.sens.auto.label", hintKey: "voice.sens.auto.hint" },
  { value: "manual", labelKey: "voice.sens.manual.label", hintKey: "voice.sens.manual.hint" },
];

/** Texto de cada fase do teste de gravação. Vai numa região `aria-live`. */
export function micTestText(state: MicTestState | null): string {
  if (!state) return t("voice.mictest.idle");
  const secs = Math.ceil((state.remainingMs ?? 0) / 1000);
  switch (state.phase) {
    case "requesting":
      return t("voice.mictest.requesting");
    case "recording":
      return t("voice.mictest.recording", { secs });
    case "playing":
      return t("voice.mictest.playing", { secs });
    case "done":
      return t("voice.mictest.done");
    case "error":
      switch (state.error) {
        case "permission-denied":
          return t("voice.mictest.denied");
        case "not-found":
          return t("voice.mictest.notFound");
        case "in-use":
          return t("voice.mictest.inUse");
        default:
          return t("voice.mictest.failed");
      }
  }
}

/** Já há permissão de microfone (o medidor pode ligar sem pedir nada)? */
async function micPermissionGranted(): Promise<boolean> {
  try {
    const status = await navigator.permissions?.query({ name: "microphone" as PermissionName });
    return status?.state === "granted";
  } catch {
    return false;
  }
}

/**
 * Medidor de nível, sensibilidade de entrada (porta de ruído) e teste de gravação. Só aparece conforme as
 * capacidades da engine; o medidor é alimentado pelo evento `input-level`, de qualquer engine que o emita.
 */
export function MicTestSection({
  open,
  processing,
  caps,
  inCall,
  onChange,
}: {
  open: boolean;
  processing: AudioProcessingOptions;
  caps: AudioCapabilities;
  /** Em chamada com o microfone aberto, o teste de gravação fica bloqueado. */
  inCall: boolean;
  onChange: (next: AudioProcessingOptions) => void;
}) {
  const { t } = useT();
  const [meterOn, setMeterOn] = useState(false);
  const level = useInputLevelStore((s) => s.level);
  const test = useMicTestStore((s) => s.state);
  const sens = processing.inputSensitivity;
  const hasMeter = caps.inputSensitivity === true;
  const testing =
    test?.phase === "requesting" || test?.phase === "recording" || test?.phase === "playing";

  // O medidor liga sozinho se não precisa pedir permissão (ou se o microfone já está aberto na chamada).
  useEffect(() => {
    if (!open || !hasMeter) return;
    let alive = true;
    void (async () => {
      if ((micTestBlockedByCall() || (await micPermissionGranted())) && alive) {
        await startInputMonitor();
        if (alive) setMeterOn(true);
      }
    })();
    return () => {
      alive = false;
      setMeterOn(false);
      cancelMicTest();
      stopInputMonitor();
    };
  }, [open, hasMeter]);

  const setSens = (next: Partial<InputSensitivity>) =>
    onChange({ ...processing, inputSensitivity: { ...sens, ...next } });

  return (
    <section aria-labelledby="mic-test-title" className="flex flex-col gap-3 border-t pt-3">
      <h3 id="mic-test-title" className="text-sm font-medium">
        {t("voice.mictest.title")}
      </h3>
      {hasMeter ? (
        <>
          {meterOn ? (
            <MicMeter
              level={level}
              gateOn={sens.mode !== "off"}
              thresholdDb={sens.mode === "manual" ? sens.thresholdDb : undefined}
            />
          ) : (
            <Button
              variant="secondary"
              size="sm"
              className="self-start"
              onClick={() => {
                setMeterOn(true);
                void startInputMonitor();
              }}
            >
              {t("voice.mictest.enableMeter")}
            </Button>
          )}
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1 text-sm">{t("voice.mictest.sensitivity")}</legend>
            {MODES.map(({ value, labelKey, hintKey }) => {
              const id = `sensitivity-${value}`;
              return (
                <label
                  key={value}
                  htmlFor={id}
                  className="flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm has-[:checked]:border-primary has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
                >
                  <input
                    id={id}
                    type="radio"
                    name="input-sensitivity"
                    value={value}
                    className="mt-1 accent-primary"
                    checked={sens.mode === value}
                    aria-describedby={`${id}-hint`}
                    onChange={() => setSens({ mode: value })}
                  />
                  <span className="flex flex-col">
                    <span>{t(labelKey)}</span>
                    <span id={`${id}-hint`} className="text-xs text-muted-foreground">
                      {t(hintKey)}
                    </span>
                  </span>
                </label>
              );
            })}
            {sens.mode === "manual" ? (
              <div className="flex flex-col gap-1">
                <label htmlFor="sensitivity-threshold" className="text-sm">
                  {t("voice.mictest.threshold", { db: sens.thresholdDb })}
                </label>
                <input
                  id="sensitivity-threshold"
                  type="range"
                  min={SENSITIVITY_RANGE.min}
                  max={SENSITIVITY_RANGE.max}
                  step={1}
                  value={sens.thresholdDb}
                  aria-valuetext={t("voice.mictest.decibels", { db: sens.thresholdDb })}
                  onChange={(e) => setSens({ thresholdDb: Number(e.target.value) })}
                  className="accent-primary"
                />
                <p className="text-xs text-muted-foreground">{t("voice.mictest.thresholdHint")}</p>
              </div>
            ) : null}
          </fieldset>
        </>
      ) : null}
      {caps.micTest ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-3">
            {testing ? (
              <Button variant="secondary" size="sm" onClick={() => cancelMicTest()}>
                {t("voice.mictest.cancel")}
              </Button>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                disabled={inCall}
                onClick={() => void runMicTest()}
              >
                {t("voice.mictest.run")}
              </Button>
            )}
          </div>
          <p aria-live="polite" className="text-xs text-muted-foreground">
            {inCall && !testing ? t("voice.mictest.inUse") : micTestText(test)}
          </p>
        </div>
      ) : null}
    </section>
  );
}
