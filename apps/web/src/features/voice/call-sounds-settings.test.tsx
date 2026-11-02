import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadCallSoundPrefs } from "./call-sounds";
import { CallSoundsGroup } from "./call-sounds-settings";

const played = vi.hoisted(() => ({ kinds: [] as string[] }));
vi.mock("./call-sounds", async (orig) => {
  const mod = await orig<typeof import("./call-sounds")>();
  return { ...mod, playCallSound: (k: string) => void played.kinds.push(k) };
});

beforeEach(() => {
  localStorage.clear();
  played.kinds.length = 0;
});

describe("Sons da chamada", () => {
  it("desliga um tipo de som e grava a preferência", async () => {
    render(<CallSoundsGroup />);
    const sw = screen.getByRole("switch", { name: /Alguém entrou ou saiu/ });
    expect(sw).toBeChecked();
    await userEvent.click(sw);
    expect(loadCallSoundPrefs().groups.peers).toBe(false);
    expect(screen.getByRole("button", { name: /Ouvir: Alguém entrou/ })).toBeDisabled();
  });

  it("o volume é único e persiste", () => {
    render(<CallSoundsGroup />);
    const range = screen.getByLabelText(/Volume dos sons/);
    fireEvent.change(range, { target: { value: "20" } });
    expect(loadCallSoundPrefs().volume).toBeCloseTo(0.2);
  });

  it("o botão de ouvir toca um exemplo do tipo", async () => {
    render(<CallSoundsGroup />);
    await userEvent.click(screen.getByRole("button", { name: /Ouvir: Entrar e sair/ }));
    expect(played.kinds).toEqual(["join"]);
  });
});
