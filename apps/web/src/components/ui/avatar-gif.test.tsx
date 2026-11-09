import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Avatar } from "./avatar";
import { BannerImage } from "./banner-image";
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

  it("dono sem plano (grátis ou ausente): fica parado em always e falando; Nitro mantém as regras", async () => {
    const { rerender } = render(<Avatar url={GIF} name="Bia" animation="always" plan="free" />);
    await ready();
    expect(document.querySelector("img")).toBeNull(); // sem <img> animado
    rerender(<Avatar url={GIF} name="Bia" animation="speaking" animating plan="free" />);
    expect(live()).toBeNull();
    rerender(<Avatar url={GIF} name="Bia" animation="speaking" animating plan="nitro" />);
    expect(live()).toHaveAttribute("src", GIF);
    rerender(
      <Avatar url={GIF} name="Bia" animation="speaking" animating={false} plan="nitro_plus" />,
    );
    expect(live()).toBeNull(); // Nitro: parado quando não fala
    rerender(<Avatar url={GIF} name="Bia" animation="always" plan="nitro" />);
    expect(screen.getByRole("img")).toHaveAttribute("src", GIF);
  });

  it("sem a prop `plan` (ícone de servidor) nada muda", () => {
    render(<Avatar url={GIF} name="Bia" animation="always" />);
    expect(screen.getByRole("img")).toHaveAttribute("src", GIF);
  });
});

describe("banner GIF", () => {
  const BGIF = "https://s3.test/banners/50/9.gif?sig=abc";
  const BPNG = "https://s3.test/banners/50/9.png?sig=abc";
  beforeEach(() => {
    // jsdom não desenha: o quadro estático do banner é copiado para o canvas com este stub.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
  });

  it("dono sem plano: primeiro quadro no canvas, nunca o <img> animado", async () => {
    render(<BannerImage url={BGIF} ownerPlan="free" />);
    await ready();
    expect(document.querySelector("img")).toBeNull();
    expect(frames.loadStaticFrame).toHaveBeenCalledWith(BGIF, 640);
  });

  it("dono sem plano e sem o quadro (falha): não mostra nada, nunca cai no GIF animado", async () => {
    vi.mocked(frames.loadStaticFrame).mockResolvedValue(null);
    render(<BannerImage url={BGIF} ownerPlan={undefined} />);
    await waitFor(() => expect(frames.loadStaticFrame).toHaveBeenCalled());
    expect(document.querySelector("img")).toBeNull();
    expect(canvas()).toBeNull();
  });

  it("dono com Nitro ou Nitro+: GIF animado; não-GIF é sempre <img>", () => {
    const { rerender } = render(<BannerImage url={BGIF} ownerPlan="nitro" />);
    expect(document.querySelector("img")).toHaveAttribute("src", BGIF);
    rerender(<BannerImage url={BGIF} ownerPlan="nitro_plus" />);
    expect(document.querySelector("img")).toHaveAttribute("src", BGIF);
    rerender(<BannerImage url={BPNG} ownerPlan="free" />);
    expect(document.querySelector("img")).toHaveAttribute("src", BPNG);
    expect(frames.loadStaticFrame).not.toHaveBeenCalled();
  });
});
