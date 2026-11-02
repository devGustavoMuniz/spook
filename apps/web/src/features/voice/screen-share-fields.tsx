import { cn } from "@/lib/utils";
import {
  estimateUplinkKbps,
  formatKbps,
  isHeavy,
  qualityOf,
  SCREEN_FPS,
  SCREEN_HEIGHTS,
  type ScreenChoice,
} from "./screen-quality";

/** Seletor segmentado acessível: rádios de verdade (setas do teclado trocam), com cara de botões. */
function Segmented<T extends number>({
  name,
  label,
  options,
  value,
  format,
  onChange,
}: {
  name: string;
  label: string;
  options: readonly T[];
  value: T;
  format: (v: T) => string;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span id={`${name}-label`} className="text-sm font-medium">
        {label}
      </span>
      <div
        role="radiogroup"
        aria-labelledby={`${name}-label`}
        className="grid auto-cols-fr grid-flow-col gap-1 rounded-lg border border-border bg-surface-1 p-1"
      >
        {options.map((o) => (
          <label
            key={o}
            className={cn(
              "flex h-9 cursor-pointer items-center justify-center rounded-md px-3 text-sm font-medium transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
              value === o
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <input
              type="radio"
              name={name}
              value={o}
              checked={value === o}
              onChange={() => onChange(o)}
              className="sr-only"
            />
            {format(o)}
          </label>
        ))}
      </div>
    </div>
  );
}

/**
 * Resolução + taxa de quadros (como o Discord), com a estimativa de banda e o aviso de custo. A prioridade
 * detalhe/movimento e o teto de banda são derivados (`qualityOf`): não são escolha do usuário.
 */
export function ScreenQualityFields({
  idPrefix,
  choice,
  onChange,
}: {
  idPrefix: string;
  choice: ScreenChoice;
  onChange: (c: ScreenChoice) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <Segmented
        name={`${idPrefix}-height`}
        label="Resolução"
        options={SCREEN_HEIGHTS}
        value={choice.height}
        format={(h) => `${h}p`}
        onChange={(height) => onChange({ ...choice, height })}
      />
      <Segmented
        name={`${idPrefix}-fps`}
        label="Taxa de quadros"
        options={SCREEN_FPS}
        value={choice.fps}
        format={(f) => `${f} fps`}
        onChange={(fps) => onChange({ ...choice, fps })}
      />
      <p className="text-xs text-muted-foreground">
        Banda de subida: até {formatKbps(estimateUplinkKbps(qualityOf(choice)))} por espectador (o
        uso real costuma ser menor).
      </p>
      {isHeavy(choice) ? (
        <output className="block rounded-md border border-destructive/40 px-3 py-2 text-xs">
          1440p ou 60 fps gastam bem mais processador e internet de quem transmite e banda do
          servidor, que é pequeno. Se a chamada engasgar, volte para 1080p com 30 fps.
        </output>
      ) : null}
    </div>
  );
}
