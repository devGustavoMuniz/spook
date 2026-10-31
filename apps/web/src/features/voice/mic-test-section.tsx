import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
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

const MODES: { value: InputSensitivity["mode"]; label: string; hint: string }[] = [
  { value: "off", label: "Desligada", hint: "Todo som que o microfone captar vai para a chamada." },
  {
    value: "auto",
    label: "Automática",
    hint: "Aprende o ruído do ambiente e só abre quando você fala acima dele.",
  },
  {
    value: "manual",
    label: "Manual",
    hint: "Você define o nível mínimo. A marca vermelha no medidor mostra o limiar.",
  },
];

/** Texto (pt-br) de cada fase do teste de gravação. Vai numa região `aria-live`. */
export function micTestText(state: MicTestState | null): string {
  if (!state) return "Grave 5 segundos e ouça como os outros ouvirão você.";
  const secs = Math.ceil((state.remainingMs ?? 0) / 1000);
  switch (state.phase) {
    case "requesting":
      return "Pedindo acesso ao microfone… permita no aviso do navegador.";
    case "recording":
      return `Gravando… fale agora (${secs} s).`;
    case "playing":
      return `Reproduzindo sua gravação (${secs} s). Use fones para não gerar eco.`;
    case "done":
      return "Teste concluído. Se você se ouviu bem, está tudo certo.";
    case "error":
      switch (state.error) {
        case "permission-denied":
          return "O navegador bloqueou o microfone. Permita o acesso nas configurações do site.";
        case "not-found":
          return "Nenhum microfone encontrado.";
        case "in-use":
          return "Silencie o microfone da chamada para testar (a gravação tocaria para todos).";
        default:
          return "Não foi possível fazer o teste do microfone.";
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
        Teste do microfone
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
              Ativar medidor de nível
            </Button>
          )}
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1 text-sm">Sensibilidade de entrada</legend>
            {MODES.map(({ value, label, hint }) => {
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
                    <span>{label}</span>
                    <span id={`${id}-hint`} className="text-xs text-muted-foreground">
                      {hint}
                    </span>
                  </span>
                </label>
              );
            })}
            {sens.mode === "manual" ? (
              <div className="flex flex-col gap-1">
                <label htmlFor="sensitivity-threshold" className="text-sm">
                  Limiar: {sens.thresholdDb} dB
                </label>
                <input
                  id="sensitivity-threshold"
                  type="range"
                  min={SENSITIVITY_RANGE.min}
                  max={SENSITIVITY_RANGE.max}
                  step={1}
                  value={sens.thresholdDb}
                  aria-valuetext={`${sens.thresholdDb} decibéis`}
                  onChange={(e) => setSens({ thresholdDb: Number(e.target.value) })}
                  className="accent-primary"
                />
                <p className="text-xs text-muted-foreground">
                  Mais à esquerda = mais sensível (capta sons baixos); mais à direita = só voz alta.
                </p>
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
                Cancelar teste
              </Button>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                disabled={inCall}
                onClick={() => void runMicTest()}
              >
                Testar
              </Button>
            )}
          </div>
          <p aria-live="polite" className="text-xs text-muted-foreground">
            {inCall && !testing
              ? "Silencie o microfone da chamada para testar (a gravação tocaria para todos)."
              : micTestText(test)}
          </p>
        </div>
      ) : null}
    </section>
  );
}
