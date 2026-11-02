import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { pushSample } from "@/features/admin/use-samples";
import { BarList, Gauge, Heatmap, Sparkline, TimeSeriesChart } from "./index";

const points = Array.from({ length: 14 }, (_, i) => ({
  key: `2026-10-${String(18 + i).padStart(2, "0")}`,
  label: `${18 + i}/10`,
  value: i * 2,
}));

describe("TimeSeriesChart", () => {
  it("desenha a linha e expõe a tabela equivalente com a série anterior", () => {
    const previous = points.map((_, i) => (i >= 7 ? (i - 7) * 2 : null));
    render(<TimeSeriesChart title="Mensagens" points={points} previous={previous} />);
    expect(screen.getByRole("img", { name: /Mensagens: 14 pontos/ })).toBeInTheDocument();
    expect(screen.getByTestId("previous-line")).toHaveAttribute("stroke-dasharray");
    const table = screen.getByRole("table", { name: "Mensagens por dia (UTC)" });
    expect(within(table).getAllByRole("row")).toHaveLength(15);
    expect(
      within(table).getByRole("rowheader", { name: "2026-10-31" }).nextElementSibling,
    ).toHaveTextContent("26");
    // sem base de comparação nos 7 primeiros dias
    expect(
      within(table).getByRole("rowheader", { name: "2026-10-18" }).parentElement,
    ).toHaveTextContent("—");
    expect(screen.getAllByText("Período anterior")).toHaveLength(2); // legenda + cabeçalho da tabela
  });

  it("sem série anterior não há linha nem coluna de comparação", () => {
    render(<TimeSeriesChart title="Contas" points={points} />);
    expect(screen.queryByTestId("previous-line")).toBeNull();
    expect(screen.queryByText("Período anterior")).toBeNull();
    expect(screen.getAllByRole("columnheader")).toHaveLength(2);
  });

  it("estado vazio e carregando", () => {
    const { rerender } = render(
      <TimeSeriesChart title="Contas" points={[]} emptyText="Nada ainda." />,
    );
    expect(screen.getByText("Nada ainda.")).toBeInTheDocument();
    rerender(<TimeSeriesChart title="Contas" points={[]} loading />);
    expect(screen.getByText("Carregando…")).toBeInTheDocument();
  });

  it("série toda zerada continua desenhando (sem NaN)", () => {
    render(<TimeSeriesChart title="Zeros" points={points.map((p) => ({ ...p, value: 0 }))} />);
    expect(screen.getByTestId("current-line").getAttribute("d")).not.toMatch(/NaN/);
  });

  it("teclado: foco abre o último ponto, setas e Home/End navegam, Esc fecha", async () => {
    const user = userEvent.setup();
    render(<TimeSeriesChart title="Mensagens" points={points} />);
    const group = screen.getByRole("group", { name: /Explorar valores de Mensagens/ });
    await user.tab();
    expect(group).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent("31/10: 26");
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("status")).toHaveTextContent("30/10: 24");
    await user.keyboard("{Home}");
    expect(screen.getByRole("status")).toHaveTextContent("18/10: 0");
    await user.keyboard("{End}");
    expect(screen.getByRole("status")).toHaveTextContent("31/10: 26");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("hover mostra o balão e sair o esconde", () => {
    render(<TimeSeriesChart title="Mensagens" points={points} />);
    const group = screen.getByTestId("time-series");
    group.getBoundingClientRect = () => ({ left: 0, width: 560, top: 0, height: 160 }) as DOMRect;
    // jsdom não tem PointerEvent: um MouseEvent "pointermove" traz o clientX que o React lê.
    fireEvent(group, new MouseEvent("pointermove", { bubbles: true, clientX: 552 }));
    expect(screen.getByRole("status")).toHaveTextContent("31/10: 26");
    fireEvent(group, new MouseEvent("pointermove", { bubbles: true, clientX: 36 }));
    expect(screen.getByRole("status")).toHaveTextContent("18/10: 0");
    fireEvent.pointerLeave(group);
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("BarList", () => {
  const items = [
    { key: "a", label: "messages", value: 800, display: "800 B", detail: "5 linhas" },
    { key: "b", label: "users", value: 200, display: "200 B" },
  ];
  it("barras proporcionais, tabela acessível e balão por foco", async () => {
    const user = userEvent.setup();
    render(<BarList title="Maiores tabelas" items={items} valueHeader="Tamanho" />);
    const table = screen.getByRole("table", { name: "Maiores tabelas" });
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(
      within(table).getByRole("rowheader", { name: "messages" }).parentElement,
    ).toHaveTextContent("5 linhas");
    const bars = document.querySelectorAll<HTMLElement>("li span[style]");
    expect(bars[0]?.style.transform).toBe("scaleX(1)");
    expect(bars[1]?.style.transform).toBe("scaleX(0.25)");
    await user.tab();
    expect(screen.getByRole("status")).toHaveTextContent("messages: 800 B · 5 linhas");
  });
  it("vazio e carregando", () => {
    const { rerender } = render(<BarList title="X" items={[]} emptyText="Sem tabelas." />);
    expect(screen.getByText("Sem tabelas.")).toBeInTheDocument();
    rerender(<BarList title="X" items={[]} loading />);
    expect(screen.getByText("Carregando…")).toBeInTheDocument();
  });
});

describe("Gauge", () => {
  const props = { label: "Perda", max: 5, warnAt: 1, badAt: 3, format: (n: number) => `${n}%` };
  it.each([
    [0.5, "Bom"],
    [2, "Atenção"],
    [4, "Ruim"],
  ])("valor %s → %s (texto, não só cor)", (value, text) => {
    render(<Gauge {...props} value={value} />);
    const meter = screen.getByRole("meter", { name: "Perda" });
    expect(meter).toHaveAttribute("aria-valuenow", String(value));
    expect(meter).toHaveAttribute("aria-valuetext", `${value}%, ${text}`);
    expect(screen.getByText(text)).toBeInTheDocument();
  });
  it("sem leitura mostra traço e não desenha o ponteiro", () => {
    render(<Gauge {...props} value={null} />);
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.getByText("Sem leitura")).toBeInTheDocument();
    expect(screen.queryByTestId("gauge-needle")).toBeNull();
    expect(screen.getByRole("meter")).not.toHaveAttribute("aria-valuenow");
  });
});

describe("Sparkline", () => {
  it("resume mínimo, máximo e atual no rótulo", () => {
    render(<Sparkline values={[3, 1, 5, 4]} label="Conexões" />);
    expect(
      screen.getByRole("img", { name: /Conexões.*mínimo 1, máximo 5, atual 4/ }),
    ).toBeInTheDocument();
  });
  it("com menos de 2 amostras não desenha linha", () => {
    render(<Sparkline values={[3]} label="Conexões" />);
    expect(screen.queryByRole("img")).toBeNull();
  });
  it("valores constantes ficam no meio, sem NaN", () => {
    const { container } = render(<Sparkline values={[2, 2, 2]} label="Plano" />);
    expect(container.innerHTML).not.toMatch(/NaN/);
  });
});

describe("Heatmap", () => {
  const cells = Array.from({ length: 7 }, (_, d) =>
    Array.from({ length: 24 }, (_, h) => (d === 2 && h === 9 ? 10 : 0)),
  );
  it("7 x 24 células, tabela acessível e navegação por setas", async () => {
    const user = userEvent.setup();
    render(<Heatmap title="Mensagens por hora" cells={cells} />);
    expect(screen.getAllByRole("gridcell")).toHaveLength(168);
    const table = screen.getByRole("table", { name: "Mensagens por hora (UTC)" });
    expect(within(table).getAllByRole("row")).toHaveLength(8);
    await user.tab();
    expect(screen.getByRole("gridcell", { name: "dom 0 h: 0 mensagens" })).toHaveFocus();
    await user.keyboard("{ArrowDown}{ArrowDown}");
    for (let i = 0; i < 9; i++) await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("gridcell", { name: "ter 9 h: 10 mensagens" })).toHaveFocus();
    expect(screen.getByText(/ter, 09 h \(UTC\): 10 mensagens/)).toBeInTheDocument();
  });
  it("sem atividade mostra o estado vazio", () => {
    render(<Heatmap title="X" cells={cells.map((r) => r.map(() => 0))} />);
    expect(screen.getByText("Sem atividade registrada.")).toBeInTheDocument();
  });
});

describe("amostras do cliente", () => {
  it("descarta o que passou da janela e ignora amostra repetida", () => {
    let s = pushSample([], 0, 1, 1000);
    s = pushSample(s, 500, 2, 1000);
    s = pushSample(s, 500, 9, 1000);
    expect(s.map((x) => x.v)).toEqual([1, 2]);
    s = pushSample(s, 1400, 3, 1000);
    expect(s.map((x) => x.v)).toEqual([2, 3]);
  });
});
