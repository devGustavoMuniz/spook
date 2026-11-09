import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Avatar } from "./avatar";
import * as frames from "./static-frame";

const GIF = "https://s3.test/avatars/50/9.gif?sig=abc";
const PNG = "https://s3.test/avatars/50/9.png?sig=abc";
const fakeFrame = { canvas: document.createElement("canvas"), width: 64, height: 64 };

let reduced = false;
beforeEach(() => {
  reduced = false;
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        matches: reduced && query.includes("prefers-reduced-motion"),
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
  vi.spyOn(frames, "paintCover").mockImplementation(() => {});
  vi.spyOn(frames, "peekStaticFrame").mockReturnValue(undefined);
  vi.spyOn(frames, "loadStaticFrame").mockResolvedValue(fakeFrame);
});
afterEach(() => vi.restoreAllMocks());

const canvas = () => document.querySelector("canvas");
const ready = () => waitFor(() => expect(canvas()).not.toBeNull());
const live = () => document.querySelector("img[data-gif-live]");

describe("avatar GIF", () => {
  it("detecta GIF pelo caminho, ignorando a assinatura da query", () => {
    expect(frames.isGifUrl(GIF)).toBe(true);
    expect(frames.isGifUrl(PNG)).toBe(false);
    expect(frames.isGifUrl("https://s3.test/a.png?x=.gif")).toBe(false);
    expect(frames.isGifUrl(undefined)).toBe(false);
    expect(frames.frameKey(GIF)).toBe("https://s3.test/avatars/50/9.gif");
  });

  it("por padrão (never) mostra o primeiro quadro no canvas e nunca o <img> animado", async () => {
    render(<Avatar url={GIF} name="Bia" />);
    // placeholder (iniciais) enquanto o quadro carrega
    expect(screen.getByRole("img")).toHaveAttribute("data-initials", "BI");
    await ready();
    expect(canvas()).toHaveAttribute("aria-label");
    expect(document.querySelector("img")).toBeNull();
  });

  it("não-GIF segue como <img> comum, sem carregar quadro estático", () => {
    render(<Avatar url={PNG} name="Bia" />);
    expect(screen.getByRole("img")).toHaveAttribute("src", PNG);
    expect(frames.loadStaticFrame).not.toHaveBeenCalled();
  });

  it("always: <img> animado direto, sem canvas", () => {
    render(<Avatar url={GIF} name="Bia" animation="always" />);
    expect(screen.getByRole("img")).toHaveAttribute("src", GIF);
    expect(frames.loadStaticFrame).not.toHaveBeenCalled();
  });

  it("speaking: parado até a pessoa falar; anima enquanto fala e volta ao quadro parado", async () => {
    const { rerender } = render(
      <Avatar url={GIF} name="Bia" animation="speaking" animating={false} />,
    );
    await ready();
    expect(live()).toBeNull();

    rerender(<Avatar url={GIF} name="Bia" animation="speaking" animating />);
    expect(live()).toHaveAttribute("src", GIF);
    expect(live()).toHaveClass("opacity-0"); // entra com fade, o canvas segue por baixo
    act(() => live()?.dispatchEvent(new Event("load")));
    expect(live()).toHaveClass("opacity-100");
    expect(canvas()).not.toBeNull();

    rerender(<Avatar url={GIF} name="Bia" animation="speaking" animating={false} />);
    expect(live()).toBeNull();
  });

  it("speaking sem `animating` usa a prop `speaking` (mesmo sinal do anel verde)", async () => {
    const { rerender } = render(<Avatar url={GIF} name="Bia" animation="speaking" />);
    await ready();
    expect(live()).toBeNull();
    // `speaking` põe o anel em volta e remonta o rosto: o quadro vem do cache, sem piscar o placeholder.
    vi.mocked(frames.peekStaticFrame).mockReturnValue(fakeFrame);
    rerender(<Avatar url={GIF} name="Bia" animation="speaking" speaking />);
    expect(live()).not.toBeNull();
  });

  it("prefers-reduced-motion nunca anima, nem em always nem falando", async () => {
    reduced = true;
    const { rerender } = render(<Avatar url={GIF} name="Bia" animation="always" />);
    await ready();
    expect(document.querySelector("img")).toBeNull();
    rerender(<Avatar url={GIF} name="Bia" animation="speaking" animating />);
    expect(live()).toBeNull();
  });

  it("falha ao carregar o quadro cai nas iniciais (nunca no GIF animado)", async () => {
    vi.mocked(frames.loadStaticFrame).mockResolvedValue(null);
    render(<Avatar url={GIF} name="Bia" />);
    await act(async () => {});
    expect(screen.getByRole("img")).toHaveAttribute("data-initials", "BI");
    expect(document.querySelector("img")).toBeNull();
  });
});
