// biome-ignore-all lint/a11y/useSemanticElements: grade CSS de 24 colunas (role grid/row/gridcell); a tabela equivalente está oculta abaixo
// biome-ignore-all lint/a11y/useFocusableInteractive: foco por teclado dentro das células (roving tabindex)
import { memo, useState } from "react";
import { ChartEmpty, ChartSkeleton, ChartTable } from "./chart-parts";
import { heatLevel } from "./scales";

export const WEEKDAYS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"] as const;

/**
 * Mapa de calor hora × dia da semana. `cells[d][h]` com d = 0 (domingo) a 6 e h = 0 a 23 (UTC).
 * Escala sequencial de um só tom (roxo da marca): mais escuro = mais atividade; 0 fica neutro.
 *
 * Ainda sem uso no painel: nenhum endpoint entrega contagem por hora. Quando o backend expuser
 * (ex.: `messages_per_hour`), é só passar a matriz. Documentado em docs/design/DESIGN-SYSTEM.md.
 */
function HeatmapImpl({
  title,
  cells,
  unit = "mensagens",
  loading = false,
}: {
  title: string;
  cells: number[][];
  unit?: string;
  loading?: boolean;
}) {
  const [active, setActive] = useState<[number, number] | null>(null);
  const [tab, setTab] = useState<[number, number]>([0, 0]);
  if (loading) return <ChartSkeleton />;
  const max = Math.max(0, ...cells.flat());
  if (cells.length === 0 || max === 0) return <ChartEmpty>Sem atividade registrada.</ChartEmpty>;
  const move = (e: React.KeyboardEvent<HTMLElement>, d: number, h: number) => {
    const delta: Record<string, [number, number]> = {
      ArrowRight: [0, 1],
      ArrowLeft: [0, -1],
      ArrowDown: [1, 0],
      ArrowUp: [-1, 0],
    };
    const dd = delta[e.key];
    if (!dd) return;
    e.preventDefault();
    const nd = Math.min(cells.length - 1, Math.max(0, d + dd[0]));
    const nh = Math.min(23, Math.max(0, h + dd[1]));
    setTab([nd, nh]);
    e.currentTarget
      .closest('[role="grid"]')
      ?.querySelector<HTMLElement>(`[data-cell="${nd}-${nh}"]`)
      ?.focus();
  };
  const hours = Array.from({ length: 24 }, (_, h) => h);
  const cur = active ? (cells[active[0]]?.[active[1]] ?? 0) : null;
  return (
    <div>
      <p className="tabular mb-2 h-4 text-xs text-muted-foreground" aria-live="polite">
        {active && cur !== null
          ? `${WEEKDAYS[active[0]]}, ${String(active[1]).padStart(2, "0")} h (UTC): ${cur} ${unit}`
          : "Passe o mouse ou use Tab sobre uma célula."}
      </p>
      <div className="overflow-x-auto">
        <div
          role="grid"
          aria-label={title}
          className="grid min-w-[30rem] gap-0.5"
          style={{ gridTemplateColumns: "2rem repeat(24, minmax(0, 1fr))" }}
        >
          <span />
          {hours.map((h) => (
            <span key={h} className="text-center text-[9px] text-muted-foreground" aria-hidden>
              {h % 3 === 0 ? h : ""}
            </span>
          ))}
          {cells.map((row, d) => (
            <div key={WEEKDAYS[d]} role="row" className="contents">
              <span
                className="pr-1 text-right text-[10px] leading-4 text-muted-foreground"
                aria-hidden
              >
                {WEEKDAYS[d]}
              </span>
              {hours.map((h) => {
                const v = row[h] ?? 0;
                const lvl = heatLevel(v, max);
                return (
                  <span
                    key={h}
                    role="gridcell"
                    tabIndex={tab[0] === d && tab[1] === h ? 0 : -1}
                    data-cell={`${d}-${h}`}
                    onKeyDown={(e) => move(e, d, h)}
                    aria-label={`${WEEKDAYS[d]} ${h} h: ${v} ${unit}`}
                    onPointerEnter={() => setActive([d, h])}
                    onPointerLeave={() => setActive(null)}
                    onFocus={() => setActive([d, h])}
                    onBlur={() => setActive(null)}
                    className="h-4 rounded-[3px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    style={{
                      background:
                        lvl === 0
                          ? "var(--muted)"
                          : `color-mix(in oklab, var(--brand-500) ${Math.round(lvl * 100)}%, var(--muted))`,
                    }}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <ChartTable
        caption={`${title} (UTC)`}
        columns={["Dia", ...hours.map((h) => `${h} h`)]}
        rows={cells.map((row, d) => [WEEKDAYS[d] as string, ...hours.map((h) => row[h] ?? 0)])}
      />
    </div>
  );
}

export const Heatmap = memo(HeatmapImpl);
