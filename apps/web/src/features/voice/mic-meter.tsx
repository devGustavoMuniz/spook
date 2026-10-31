import { cn } from "@/lib/utils";
import type { InputLevel } from "./engine";

/** Escala visual do medidor, em dBFS. */
export const METER_MIN_DB = -80;
export const METER_MAX_DB = 0;

/** Posição (0 a 100 %) de um nível na escala. */
export function meterPercent(db: number): number {
  const clamped = Math.min(METER_MAX_DB, Math.max(METER_MIN_DB, db));
  return ((clamped - METER_MIN_DB) / (METER_MAX_DB - METER_MIN_DB)) * 100;
}

/**
 * Medidor de nível do microfone (já processado) com a marca do limiar e o estado da porta.
 * `thresholdDb` só aparece no modo manual; no automático a porta mostra o estado, sem marca fixa.
 */
export function MicMeter({
  level,
  thresholdDb,
  gateOn,
  className,
}: {
  level: InputLevel | null;
  thresholdDb?: number;
  /** A porta de ruído está ligada (manual/automático)? Sem ela, não há "porta aberta/fechada" a mostrar. */
  gateOn: boolean;
  className?: string;
}) {
  const db = level?.db ?? METER_MIN_DB;
  const open = level?.gateOpen ?? false;
  const state = !level
    ? "sem sinal"
    : !gateOn
      ? `${Math.round(db)} dB`
      : `${Math.round(db)} dB, porta ${open ? "aberta" : "fechada"}`;
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      {/* biome-ignore lint/a11y/useSemanticElements: barra desenhada à mão (nível + marca do limiar); <meter> não permite isso */}
      <div
        role="meter"
        aria-label="Nível do microfone"
        aria-valuemin={METER_MIN_DB}
        aria-valuemax={METER_MAX_DB}
        aria-valuenow={Math.round(Math.min(METER_MAX_DB, Math.max(METER_MIN_DB, db)))}
        aria-valuetext={state}
        className="relative h-3 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          data-testid="meter-fill"
          className={cn(
            "h-full rounded-full transition-[width] duration-75",
            gateOn && !open ? "bg-muted-foreground/60" : "bg-emerald-500",
          )}
          style={{ width: `${meterPercent(db)}%` }}
        />
        {thresholdDb !== undefined ? (
          <div
            data-testid="meter-threshold"
            aria-hidden
            className="absolute inset-y-0 w-0.5 bg-destructive"
            style={{ left: `${meterPercent(thresholdDb)}%` }}
          />
        ) : null}
      </div>
      <p className="flex justify-between text-xs text-muted-foreground">
        <span>{level ? `${Math.round(db)} dB` : "Sem sinal"}</span>
        {gateOn && level ? (
          <span data-testid="gate-state">{open ? "Porta aberta" : "Porta fechada"}</span>
        ) : null}
      </p>
    </div>
  );
}
