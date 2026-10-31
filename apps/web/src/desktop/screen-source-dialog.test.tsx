import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import {
  PORTAL_SOURCE,
  pickScreenSource,
  resetScreenPicker,
  type ScreenSource,
} from "./screen-picker";
import { ScreenSourceDialog } from "./screen-source-dialog";

const sources: ScreenSource[] = [
  { id: "display:1", name: "Tela 1", kind: "screen" },
  { id: "display:2", name: "Tela 2", kind: "screen" },
  { id: "window:9", name: "Navegador - Spook", kind: "window" },
];

afterEach(() => resetScreenPicker());

describe("seletor de fonte de compartilhamento", () => {
  it("sem diálogo montado, cancela em vez de travar", async () => {
    expect(await pickScreenSource(sources)).toBeNull();
  });

  it("no Linux (portal) não abre diálogo: o seletor é do sistema", async () => {
    expect(
      await pickScreenSource([{ id: PORTAL_SOURCE, name: "Escolher no seletor", kind: "screen" }]),
    ).toBe(PORTAL_SOURCE);
  });

  it("lista telas e janelas em grupos, com a primeira opção marcada", async () => {
    render(<ScreenSourceDialog />);
    void pickScreenSource(sources);
    expect(
      await screen.findByRole("dialog", { name: "O que você quer compartilhar?" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Telas" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Janelas" })).toBeInTheDocument();
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(3);
    expect(screen.getByRole("radio", { name: "Tela 1" })).toBeChecked();
  });

  it("escolher uma janela e compartilhar devolve o id", async () => {
    const user = userEvent.setup();
    render(<ScreenSourceDialog />);
    const result = pickScreenSource(sources);
    await user.click(await screen.findByRole("radio", { name: "Navegador - Spook" }));
    await user.click(screen.getByRole("button", { name: "Compartilhar" }));
    expect(await result).toBe("window:9");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("Cancelar e Esc devolvem null", async () => {
    const user = userEvent.setup();
    render(<ScreenSourceDialog />);
    const a = pickScreenSource(sources);
    await user.click(await screen.findByRole("button", { name: "Cancelar" }));
    expect(await a).toBeNull();
    const b = pickScreenSource(sources);
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    expect(await b).toBeNull();
  });

  it("sem nenhuma fonte, avisa e não deixa compartilhar", async () => {
    render(<ScreenSourceDialog />);
    void pickScreenSource([]);
    expect(await screen.findByText("Nenhuma tela ou janela disponível.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Compartilhar" })).toBeDisabled();
  });
});
