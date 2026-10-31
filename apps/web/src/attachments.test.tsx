import { type AttachmentPayload, Permission } from "@spook/shared";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Lightbox } from "@/features/attachments/lightbox";
import { fitSize } from "@/features/attachments/media";
import { MessageAttachments } from "@/features/attachments/message-attachments";
import { guild, ME, member, messages } from "@/test/fixtures";
import { renderApp } from "@/test/render";
import type { Backend } from "@/test/server";
import { FakeXhr } from "@/test/xhr";

const CH = "g1-txt";
const path = `/channels/g1/${CH}`;
const BASE = Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES;

function seed(permissions = BASE | Permission.ATTACH_FILES) {
  return (s: Backend["state"]) => {
    s.guilds.push(guild("g1", "Alfa", { permissions }));
    s.members.g1 = [member(ME, "ana"), member("50", "bia")];
    s.messages[CH] = messages(CH, 2, 1000);
  };
}

const png = (name = "foto.png", size = 2048) =>
  new File([new Uint8Array(size)], name, { type: "image/png" });
const input = () => screen.findByTestId("attachment-input") as Promise<HTMLInputElement>;

beforeEach(() => {
  FakeXhr.all = [];
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
});
afterEach(() => vi.unstubAllGlobals());

async function open(permissions?: number) {
  const user = userEvent.setup({ applyAccept: false });
  const app = await renderApp(path, { signedIn: true, seed: seed(permissions) });
  await screen.findByRole("log", { name: "Mensagens de geral" });
  return { user, ...app };
}

describe("anexar no composer", () => {
  it("escolher imagem: pede a URL, mostra progresso, envia só no fim e a mensagem leva o anexo", async () => {
    const { user, state } = await open();
    await user.upload(await input(), png("foto.png", 2048));

    const pending = await screen.findByRole("list", { name: "Anexos pendentes" });
    expect(within(pending).getByText("foto.png")).toBeInTheDocument();
    expect(within(pending).getByText("2 KB")).toBeInTheDocument();
    await waitFor(() => expect(FakeXhr.all).toHaveLength(1));
    expect(state.uploads.requested[0]).toMatchObject({
      channelId: CH,
      filename: "foto.png",
      content_type: "image/png",
      size: 2048,
    });
    const xhr = FakeXhr.all[0] as FakeXhr;
    expect(xhr.method).toBe("PUT");
    expect(xhr.headers).toEqual({ "Content-Type": "image/png" });

    // enquanto envia: progresso visível e o botão Enviar travado
    act(() => xhr.progress(1, 2));
    expect(within(pending).getByRole("progressbar", { name: "Enviando foto.png" })).toHaveAttribute(
      "value",
      "50",
    );
    expect(screen.getByRole("button", { name: "Enviar mensagem" })).toBeDisabled();
    expect(screen.getByText(/Enviando anexos/)).toBeInTheDocument();

    act(() => xhr.finish(200));
    expect(await within(pending).findByText("Pronto")).toBeInTheDocument();
    const send = screen.getByRole("button", { name: "Enviar mensagem" });
    expect(send).toBeEnabled(); // conteúdo vazio é permitido com anexo

    await user.click(send);
    await waitFor(() =>
      expect(screen.queryByRole("list", { name: "Anexos pendentes" })).toBeNull(),
    );
    const posted = state.requests.find((r) => r.method === "POST" && r.path.endsWith("/messages"));
    expect(posted?.body).toEqual({
      content: "",
      attachment_ids: [expect.any(String)],
    });
    expect(await screen.findByRole("link", { name: /Baixar arquivo-/ })).toBeInTheDocument();
  });

  it("cancelar um envio em andamento aborta o XHR e some da lista", async () => {
    const { user } = await open();
    await user.upload(await input(), png());
    await waitFor(() => expect(FakeXhr.all).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "Cancelar envio de foto.png" }));
    expect((FakeXhr.all[0] as FakeXhr).aborted).toBe(true);
    expect(screen.queryByRole("list", { name: "Anexos pendentes" })).toBeNull();
  });

  it("recusa no cliente arquivo acima de 25 MB e tipo proibido, com mensagem, sem pedir upload", async () => {
    const { user, state } = await open();
    const big = png("grande.png");
    Object.defineProperty(big, "size", { value: 26 * 1024 * 1024 });
    await user.upload(await input(), [
      big,
      new File(["<svg/>"], "x.svg", { type: "image/svg+xml" }),
    ]);
    expect(await screen.findByText(/"grande.png" passa do limite de 25 MB/)).toBeInTheDocument();
    expect(
      await screen.findByText(/"x.svg": este tipo de arquivo não é permitido/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Anexos pendentes" })).toBeNull();
    expect(state.uploads.requested).toHaveLength(0);
  });

  it("erro do servidor no pedido do upload aparece no arquivo e dá para tentar de novo", async () => {
    const { user, state } = await open();
    state.uploads.error = { status: 503, detail: "armazenamento desligado" };
    await user.upload(await input(), png());
    const alert = await screen.findByText("O envio de arquivos está indisponível no momento.");
    expect(alert).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enviar mensagem" })).toBeDisabled();
    expect(screen.getByText(/Há anexos com erro/)).toBeInTheDocument();
    state.uploads.error = null;
    await user.click(screen.getByRole("button", { name: "Tentar enviar foto.png de novo" }));
    await waitFor(() => expect(FakeXhr.all).toHaveLength(1));
  });

  it("falha do storage no PUT mostra o código", async () => {
    const { user } = await open();
    await user.upload(await input(), png());
    await waitFor(() => expect(FakeXhr.all).toHaveLength(1));
    act(() => (FakeXhr.all[0] as FakeXhr).finish(403));
    expect(
      await screen.findByText("O armazenamento recusou o arquivo (código 403)."),
    ).toBeInTheDocument();
  });

  it("limite de 10 anexos por mensagem", async () => {
    const { user } = await open();
    const files = Array.from({ length: 11 }, (_, i) => png(`f${i}.png`));
    await user.upload(await input(), files);
    expect(await screen.findByText(/no máximo 10 arquivos/)).toBeInTheDocument();
    const pending = await screen.findByRole("list", { name: "Anexos pendentes" });
    expect(within(pending).getAllByRole("listitem")).toHaveLength(10);
    expect(screen.getByRole("button", { name: "Anexar arquivo" })).toBeDisabled();
  });

  it("colar imagem no campo de texto anexa o arquivo", async () => {
    await open();
    const box = await screen.findByLabelText("Mensagem em #geral");
    fireEvent.paste(box, { clipboardData: { files: [png("image.png")], getData: () => "" } });
    expect(await screen.findByText("image.png")).toBeInTheDocument();
  });

  it("arrastar e soltar arquivos sobre o canal anexa; arrasto de texto é ignorado", async () => {
    await open();
    const area = (await screen.findByRole("log", { name: "Mensagens de geral" })).closest(
      "[class*='relative']",
    ) as HTMLElement;
    fireEvent.dragEnter(area, { dataTransfer: { types: ["text/plain"] } });
    expect(screen.queryByText("Solte para anexar")).toBeNull();
    fireEvent.dragEnter(area, { dataTransfer: { types: ["Files"] } });
    expect(await screen.findByText("Solte para anexar")).toBeInTheDocument();
    fireEvent.drop(area, { dataTransfer: { types: ["Files"], files: [png("solto.png")] } });
    expect(await screen.findByText("solto.png")).toBeInTheDocument();
    expect(screen.queryByText("Solte para anexar")).toBeNull();
  });

  it("com texto e anexo, envia os dois; falha 422 devolve os anexos a 'erro' para reenviar", async () => {
    const { user, state } = await open();
    await user.upload(await input(), png());
    await waitFor(() => expect(FakeXhr.all).toHaveLength(1));
    act(() => (FakeXhr.all[0] as FakeXhr).finish(200));
    await screen.findByText("Pronto");
    await user.type(screen.getByLabelText("Mensagem em #geral"), "olha isso");
    const { server } = await import("@/test/server");
    const { http, HttpResponse } = await import("msw");
    server.use(
      http.post("*/api/channels/:id/messages", () =>
        HttpResponse.json(
          { title: "422", status: 422, detail: "anexo inválido: arquivo ausente", errors: [] },
          { status: 422 },
        ),
      ),
    );
    await user.click(screen.getByRole("button", { name: "Enviar mensagem" }));
    expect(await screen.findByText(/Anexo recusado: anexo inválido/)).toBeInTheDocument();
    expect(await screen.findByText("Envie este arquivo de novo.")).toBeInTheDocument();
    expect(state.uploads.requested).toHaveLength(1);
    expect(screen.getByLabelText("Mensagem em #geral")).toHaveValue("olha isso");
  });
});

describe("sem ATTACH_FILES", () => {
  it("o botão fica desabilitado com explicação, e soltar arquivos avisa em vez de anexar", async () => {
    const { user, state } = await open(BASE);
    expect(screen.getByRole("button", { name: "Anexar arquivo" })).toBeDisabled();
    expect(
      screen.getByText("Você não tem permissão para anexar arquivos neste canal."),
    ).toBeInTheDocument();
    const box = await screen.findByLabelText("Mensagem em #geral");
    fireEvent.paste(box, { clipboardData: { files: [png()], getData: () => "" } });
    await waitFor(() =>
      expect(
        screen.getAllByText("Você não tem permissão para anexar arquivos neste canal."),
      ).toHaveLength(2),
    );
    expect(state.uploads.requested).toHaveLength(0);
    // mensagens de texto seguem funcionando
    await user.type(box, "oi{Enter}");
    await waitFor(() =>
      expect(state.requests.some((r) => r.method === "POST" && r.path.endsWith("/messages"))).toBe(
        true,
      ),
    );
  });
});

const img = (id: string, extra: Partial<AttachmentPayload> = {}): AttachmentPayload => ({
  id,
  filename: `${id}.png`,
  content_type: "image/png",
  size: 5000,
  url: `https://s.test/orig/${id}`,
  ...extra,
});

describe("anexos na mensagem", () => {
  it("imagem usa o thumbnail e reserva a proporção quando width/height existem", () => {
    render(
      <MessageAttachments
        attachments={[img("a", { thumbnail_url: "https://s.test/th/a", width: 1600, height: 800 })]}
      />,
    );
    const image = screen.getByRole("img", { name: "a.png" });
    expect(image).toHaveAttribute("src", "https://s.test/th/a");
    const box = image.closest("button") as HTMLElement;
    expect(box.style.aspectRatio).toBe("400 / 200");
    expect(box.style.width).toBe("400px");
  });

  it("sem thumbnail ainda: mostra o original; quando o MESSAGE_UPDATE traz o thumbnail, troca no mesmo elemento", () => {
    const { rerender } = render(<MessageAttachments attachments={[img("a")]} />);
    const before = screen.getByRole("img", { name: "a.png" });
    expect(before).toHaveAttribute("src", "https://s.test/orig/a");
    rerender(
      <MessageAttachments
        attachments={[img("a", { thumbnail_url: "https://s.test/th/a", width: 1000, height: 500 })]}
      />,
    );
    const after = screen.getByRole("img", { name: "a.png" });
    expect(after).toBe(before); // não remonta: sem piscar nem pular
    expect(after).toHaveAttribute("src", "https://s.test/th/a");
  });

  it("thumbnail que falha cai para o original; os dois falhando mostram aviso", () => {
    render(
      <MessageAttachments attachments={[img("a", { thumbnail_url: "https://s.test/th/a" })]} />,
    );
    fireEvent.error(screen.getByRole("img", { name: "a.png" }));
    expect(screen.getByRole("img", { name: "a.png" })).toHaveAttribute(
      "src",
      "https://s.test/orig/a",
    );
    fireEvent.error(screen.getByRole("img", { name: "a.png" }));
    expect(screen.getByText(/Não foi possível carregar a.png/)).toBeInTheDocument();
  });

  it("clique abre o visualizador; setas navegam; Esc fecha", async () => {
    const user = userEvent.setup();
    render(<MessageAttachments attachments={[img("a"), img("b"), img("c")]} />);
    await user.click(screen.getByRole("button", { name: "Abrir imagem b.png" }));
    const dialog = await screen.findByRole("dialog", { name: "Imagem b.png" });
    expect(within(dialog).getByRole("img", { name: "b.png" })).toHaveAttribute(
      "src",
      "https://s.test/orig/b",
    );
    expect(within(dialog).getByText("2 / 3")).toBeInTheDocument();
    await user.keyboard("{ArrowRight}");
    expect(within(dialog).getByRole("img", { name: "c.png" })).toBeInTheDocument();
    await user.keyboard("{ArrowRight}"); // dá a volta
    expect(within(dialog).getByRole("img", { name: "a.png" })).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Imagem anterior" }));
    expect(within(dialog).getByRole("img", { name: "c.png" })).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "Baixar c.png" })).toHaveAttribute(
      "href",
      "https://s.test/orig/c",
    );
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // o foco volta ao gatilho
    expect(screen.getByRole("button", { name: "Abrir imagem b.png" })).toHaveFocus();
  });

  it("imagem única: sem setas nem contador", async () => {
    const user = userEvent.setup();
    render(<MessageAttachments attachments={[img("a")]} />);
    await user.click(screen.getByRole("button", { name: "Abrir imagem a.png" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("button", { name: "Próxima imagem" })).toBeNull();
    expect(within(dialog).queryByText(/\d \/ \d/)).toBeNull();
  });

  it("outros arquivos viram cartão com ícone, nome, tamanho e baixar", () => {
    render(
      <MessageAttachments
        attachments={[
          {
            id: "p",
            filename: "relatório.pdf",
            content_type: "application/pdf",
            size: 1.5 * 1024 * 1024,
            url: "https://s.test/orig/p",
          },
        ]}
      />,
    );
    expect(screen.getByText("relatório.pdf")).toBeInTheDocument();
    expect(screen.getByText("1,5 MB")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Baixar relatório.pdf" });
    expect(link).toHaveAttribute("href", "https://s.test/orig/p");
    expect(link).toHaveAttribute("download", "relatório.pdf");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("áudio e vídeo usam o player nativo", () => {
    const { container } = render(
      <MessageAttachments
        attachments={[
          {
            id: "au",
            filename: "voz.mp3",
            content_type: "audio/mpeg",
            size: 100,
            url: "https://s.test/au",
          },
          {
            id: "vi",
            filename: "clipe.mp4",
            content_type: "video/mp4",
            size: 100,
            url: "https://s.test/vi",
          },
        ]}
      />,
    );
    expect(container.querySelector("audio[controls]")).toHaveAttribute("src", "https://s.test/au");
    expect(container.querySelector("video[controls]")).toHaveAttribute("src", "https://s.test/vi");
  });

  it("Lightbox fechado não renderiza nada", () => {
    render(
      <Lightbox images={[img("a")]} index={null} onIndexChange={() => {}} onClose={() => {}} />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("fitSize", () => {
  it("cabe em 400x300, mantém a proporção e nunca amplia", () => {
    expect(fitSize(1600, 800)).toEqual({ width: 400, height: 200 });
    expect(fitSize(600, 900)).toEqual({ width: 200, height: 300 });
    expect(fitSize(100, 50)).toEqual({ width: 100, height: 50 });
  });
});
