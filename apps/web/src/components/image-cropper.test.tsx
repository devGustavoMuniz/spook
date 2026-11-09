import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImageCropDialog } from "@/components/image-cropper";

const renderCrop = vi.fn();
vi.mock("@/lib/crop-image", () => ({
  renderCrop: (...a: unknown[]) => renderCrop(...a),
}));

function webpHeader(animated: boolean) {
  const b = new Uint8Array(32);
  b.set(
    [..."RIFF"].map((c) => c.charCodeAt(0)),
    0,
  );
  b.set(
    [..."WEBP"].map((c) => c.charCodeAt(0)),
    8,
  );
  b.set(
    [..."VP8X"].map((c) => c.charCodeAt(0)),
    12,
  );
  b[20] = animated ? 0x12 : 0x10;
  return b;
}

async function open(file: File, kind: "avatar" | "banner" | "icon", w = 2000, h = 1000) {
  const onCancel = vi.fn();
  const onApply = vi.fn();
  render(<ImageCropDialog file={file} kind={kind} onCancel={onCancel} onApply={onApply} />);
  // O <img> de medição (sr-only) é o que informa o tamanho natural.
  const loader = document.querySelector("img.sr-only") as HTMLImageElement;
  Object.defineProperty(loader, "naturalWidth", { value: w });
  Object.defineProperty(loader, "naturalHeight", { value: h });
  fireEvent.load(loader);
  await screen.findByTestId("crop-image");
  return { onCancel, onApply };
}

beforeEach(() => {
  vi.stubGlobal(
    "URL",
    Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => {} }),
  );
  renderCrop.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

const png = () => new File([new Uint8Array(8)], "foto.png", { type: "image/png" });

describe("ImageCropDialog", () => {
  it("avatar: moldura quadrada, máscara circular, prévias nos tamanhos de uso e foco na moldura", async () => {
    await open(png(), "avatar");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    const frame = screen.getByTestId("crop-frame");
    expect(frame.style.aspectRatio).toBe("1");
    expect(screen.getByRole("heading", { name: "Ajustar avatar" })).toBeInTheDocument();
    const previews = screen.getByRole("region", { name: "Pré-visualização" });
    expect(previews.querySelectorAll("[aria-hidden] img")).toHaveLength(3);
    // Imagem 2000x1000 em moldura 1:1: a janela mostra a metade central (largura 50%).
    expect(screen.getByTestId("crop-image").style.width).toBe("200%");
  });

  it("banner usa a proporção 4:1 e uma prévia só", async () => {
    await open(png(), "banner", 2000, 1000);
    expect(screen.getByTestId("crop-frame").style.aspectRatio).toBe("4");
    expect(
      screen.getByRole("region", { name: "Pré-visualização" }).querySelectorAll("img"),
    ).toHaveLength(1);
  });

  it("setas movem a imagem e +/- mudam o zoom (a prévia acompanha)", async () => {
    await open(png(), "avatar", 2000, 1000);
    const img = screen.getByTestId("crop-image");
    const frame = screen.getByTestId("crop-frame");
    const left0 = img.style.left;
    fireEvent.keyDown(frame, { key: "ArrowRight" });
    expect(img.style.left).not.toBe(left0);
    expect(screen.getByTestId("crop-preview").querySelector("img")?.style.left).toBe(
      img.style.left,
    );
    const w0 = img.style.width;
    fireEvent.keyDown(frame, { key: "+" });
    expect(img.style.width).not.toBe(w0);
    fireEvent.keyDown(frame, { key: "-" });
    expect(img.style.width).toBe(w0);
  });

  it("Esc e Cancelar chamam onCancel", async () => {
    const { onCancel } = await open(png(), "avatar");
    await userEvent.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it("Aplicar em estático gera o arquivo recortado pelo retângulo visível", async () => {
    renderCrop.mockResolvedValue(new File(["x"], "foto.png", { type: "image/png" }));
    const { onApply } = await open(png(), "avatar", 2000, 1000);
    await userEvent.click(screen.getByRole("button", { name: "Aplicar" }));
    await waitFor(() => expect(onApply).toHaveBeenCalled());
    const [file, rect, kind] = renderCrop.mock.calls[0] as [
      File,
      { x: number; y: number; w: number; h: number },
      string,
    ];
    expect(file.name).toBe("foto.png");
    expect(rect).toEqual({ x: 500, y: 0, w: 1000, h: 1000 });
    expect(kind).toBe("avatar");
    expect(onApply.mock.calls[0]?.[0]).toMatchObject({ mode: "file" });
  });

  it("falha ao recortar mostra erro e mantém o diálogo", async () => {
    renderCrop.mockRejectedValue(new Error("x"));
    const { onApply } = await open(png(), "avatar");
    await userEvent.click(screen.getByRole("button", { name: "Aplicar" }));
    expect(await screen.findByText(/Não foi possível recortar/)).toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("GIF devolve o original e o retângulo em pixels (o servidor recorta); inteiro vira null", async () => {
    const gif = new File([new Uint8Array(8)], "a.gif", { type: "image/gif" });
    const first = await open(gif, "avatar", 400, 400);
    await userEvent.click(screen.getByRole("button", { name: "Aplicar" }));
    expect(first.onApply).toHaveBeenCalledWith({ mode: "gif", file: gif, rect: null });
    expect(renderCrop).not.toHaveBeenCalled();
  });

  it("GIF com zoom envia retângulo inteiro dentro da imagem", async () => {
    const gif = new File([new Uint8Array(8)], "a.gif", { type: "image/gif" });
    const { onApply } = await open(gif, "avatar", 400, 400);
    fireEvent.keyDown(screen.getByTestId("crop-frame"), { key: "+" });
    await userEvent.click(screen.getByRole("button", { name: "Aplicar" }));
    expect(onApply).toHaveBeenCalledWith({
      mode: "gif",
      file: gif,
      rect: { x: 40, y: 40, w: 320, h: 320 },
    });
  });

  it("WebP animado não recorta: avisa, trava os controles e aplica o arquivo como está", async () => {
    const file = new File([webpHeader(true)], "a.webp", { type: "image/webp" });
    // jsdom não implementa Blob#arrayBuffer em fatias; garante a leitura do cabeçalho.
    file.slice = () => ({ arrayBuffer: async () => webpHeader(true).buffer }) as Blob;
    const { onApply } = await open(file, "avatar");
    await screen.findByText(/não pode ser recortada/);
    expect(screen.getByRole("slider", { name: "Zoom" })).toHaveAttribute("data-disabled");
    const w0 = screen.getByTestId("crop-image").style.width;
    fireEvent.keyDown(screen.getByTestId("crop-frame"), { key: "+" });
    expect(screen.getByTestId("crop-image").style.width).toBe(w0);
    await userEvent.click(screen.getByRole("button", { name: "Aplicar" }));
    expect(onApply).toHaveBeenCalledWith({ mode: "file", file });
    expect(renderCrop).not.toHaveBeenCalled();
    await act(async () => {});
  });
});
