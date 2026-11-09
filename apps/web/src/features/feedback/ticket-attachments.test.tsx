import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { server } from "@/test/server";
import { FakeXhr } from "@/test/xhr";
import { TicketThread } from "./ticket-thread";

const attachment = {
  id: "a1",
  filename: "erro.png",
  content_type: "image/png",
  size: 1234,
  url: "https://storage.test/tickets/t1/a1.png",
};
const ticket = {
  id: "t1",
  kind: "bug",
  status: "answered",
  title: "Tela preta",
  message_count: 2,
  unread: false,
  created_at: "2026-01-01T10:00:00Z",
  last_activity_at: "2026-01-01T10:00:00Z",
  messages: [
    {
      id: "m1",
      kind: "user",
      body: "Veja o print",
      created_at: "2026-01-01T10:00:00Z",
      attachments: [attachment],
    },
    {
      id: "m2",
      kind: "admin",
      body: "Obrigado",
      created_at: "2026-01-01T11:00:00Z",
      attachments: [],
    },
  ],
};

const png = () => new File([new Uint8Array(10)], "image.png", { type: "image/png" });

function setup() {
  const posted: { upload?: unknown; reply?: unknown } = {};
  server.use(
    http.get("*/api/tickets/t1", () => HttpResponse.json(ticket)),
    http.get("*/api/tickets", () => HttpResponse.json({ items: [], next_cursor: null })),
    http.post("*/api/tickets/uploads", async ({ request }) => {
      posted.upload = await request.json();
      return HttpResponse.json(
        {
          id: "up1",
          ticket_id: "t1",
          upload_url: "https://storage.test/put",
          headers: { "Content-Type": "image/png" },
          expires_in: 300,
        },
        { status: 201 },
      );
    }),
    http.post("*/api/tickets/t1/messages", async ({ request }) => {
      posted.reply = await request.json();
      return HttpResponse.json(
        {
          id: "m3",
          kind: "user",
          body: "x",
          created_at: "2026-01-01T12:00:00Z",
          attachments: [attachment],
        },
        { status: 201 },
      );
    }),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <ThemeProvider>
      <QueryClientProvider client={qc}>
        <TicketThread id="t1" onBack={() => {}} />
        <Toaster />
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return posted;
}

beforeEach(() => {
  FakeXhr.all = [];
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
});
afterEach(() => vi.unstubAllGlobals());

describe("anexos na conversa do chamado", () => {
  it("mostra a miniatura da imagem da mensagem, clicável para abrir em tamanho cheio", async () => {
    setup();
    const thumb = await screen.findByRole("button", { name: /erro\.png/ });
    expect(thumb.querySelector("img")).toHaveAttribute("src", attachment.url);
  });

  it("cola uma captura, envia ao storage e manda attachment_ids na resposta", async () => {
    const posted = setup();
    const box = await screen.findByLabelText("Responder", { selector: "textarea" });
    fireEvent.paste(box, { clipboardData: { files: [png()], getData: () => "" } });
    await waitFor(() => expect(FakeXhr.all).toHaveLength(1));
    expect(posted.upload).toMatchObject({ ticket_id: "t1", content_type: "image/png", size: 10 });
    act(() => (FakeXhr.all[0] as FakeXhr).finish(200));
    await screen.findByText("Pronto");

    await userEvent.type(box, "Segue o print");
    await userEvent.click(screen.getByRole("button", { name: "Responder" }));
    await waitFor(() => expect(posted.reply).toBeDefined());
    expect(posted.reply).toEqual({ body: "Segue o print", attachment_ids: ["up1"] });
  });

  it("recusa no cliente o que não é PNG, JPEG ou WebP", async () => {
    setup();
    const box = await screen.findByLabelText("Responder", { selector: "textarea" });
    const gif = new File([new Uint8Array(10)], "anim.gif", { type: "image/gif" });
    fireEvent.paste(box, { clipboardData: { files: [gif], getData: () => "" } });
    expect(await screen.findByText(/só são aceitas imagens PNG, JPEG ou WebP/)).toBeInTheDocument();
    expect(FakeXhr.all).toHaveLength(0);
  });
});
