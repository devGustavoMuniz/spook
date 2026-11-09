import { describe, expect, it, vi } from "vitest";
import {
  createTicketUploader,
  nameCapture,
  pinAttachmentUrls,
  TICKET_MAX_BYTES,
  validateTicketImage,
} from "./attachments";

const file = (name: string, type: string, size = 10) =>
  new File([new Uint8Array(size)], name, { type });

describe("validateTicketImage", () => {
  it("aceita PNG, JPEG e WebP de até 5 MB", () => {
    expect(validateTicketImage(file("a.png", "image/png"))).toBeNull();
    expect(validateTicketImage(file("a.jpeg", "image/jpeg"))).toBeNull();
    expect(validateTicketImage(file("a.webp", "image/webp"))).toBeNull();
    expect(validateTicketImage(file("a.png", "image/png", TICKET_MAX_BYTES))).toBeNull();
  });

  it("recusa vazio, grande demais, GIF, PDF, SVG e extensão que não combina", () => {
    expect(validateTicketImage(file("a.png", "image/png", 0))).toMatch(/vazio/);
    expect(validateTicketImage(file("a.png", "image/png", TICKET_MAX_BYTES + 1))).toMatch(
      /limite de 5/,
    );
    for (const [n, t] of [
      ["a.gif", "image/gif"],
      ["a.pdf", "application/pdf"],
      ["a.svg", "image/svg+xml"],
    ] as const) {
      expect(validateTicketImage(file(n, t))).toMatch(/PNG, JPEG ou WebP/);
    }
    expect(validateTicketImage(file("a.jpg", "image/png"))).not.toBeNull();
  });
});

describe("nameCapture", () => {
  it("dá nome com extensão a imagens coladas sem nome ou com nome incoerente", () => {
    expect(nameCapture(file("", "image/png"), 2).name).toBe("captura-2.png");
    expect(nameCapture(file("image", "image/webp"), 1).name).toBe("captura-1.webp");
    expect(nameCapture(file("print.jpg", "image/jpeg"), 1).name).toBe("print.jpg");
  });
});

describe("createTicketUploader", () => {
  const body = { filename: "a.png", content_type: "image/png", size: 10 };
  const reply = (id: string, ticket: string) => ({
    id,
    ticket_id: ticket,
    upload_url: "https://s/x",
    headers: {},
    expires_in: 300,
  });

  it("chamado existente: todo pedido leva o ID do chamado", async () => {
    const api = vi.fn(async () => reply("u", "T1"));
    const up = createTicketUploader("T1", api);
    await up.requestUpload("T1", body);
    expect(api).toHaveBeenCalledWith({ ...body, ticket_id: "T1" });
    expect(up.getDraftId()).toBeUndefined();
  });

  it("chamado novo: o primeiro pedido reserva o rascunho e os paralelos esperam e o reutilizam", async () => {
    let n = 0;
    const api = vi.fn(async (b: { ticket_id?: string }) =>
      reply(`u${++n}`, b.ticket_id ?? "DRAFT"),
    );
    const up = createTicketUploader(undefined, api);
    await Promise.all([
      up.requestUpload("d", body),
      up.requestUpload("d", body),
      up.requestUpload("d", body),
    ]);
    expect(api.mock.calls[0]?.[0]).not.toHaveProperty("ticket_id");
    expect(api.mock.calls.slice(1).map((c) => (c[0] as { ticket_id: string }).ticket_id)).toEqual([
      "DRAFT",
      "DRAFT",
    ]);
    expect(up.getDraftId()).toBe("DRAFT");
    up.reset();
    expect(up.getDraftId()).toBeUndefined();
  });

  it("se o primeiro pedido falha, o rascunho é descartado e o próximo tenta de novo", async () => {
    const api = vi
      .fn()
      .mockRejectedValueOnce(new Error("rede"))
      .mockResolvedValueOnce(reply("u", "D2"));
    const up = createTicketUploader(undefined, api);
    await expect(up.requestUpload("d", body)).rejects.toThrow("rede");
    await up.requestUpload("d", body);
    expect(up.getDraftId()).toBe("D2");
  });
});

describe("pinAttachmentUrls", () => {
  it("mantém a primeira URL por 10 min e renova depois", () => {
    const a = { id: "pin1", url: "https://s/1?sig=a" };
    const t0 = 1_000_000;
    expect(pinAttachmentUrls([a], t0)[0]?.url).toBe("https://s/1?sig=a");
    expect(pinAttachmentUrls([{ ...a, url: "https://s/1?sig=b" }], t0 + 60_000)[0]?.url).toBe(
      "https://s/1?sig=a",
    );
    expect(pinAttachmentUrls([{ ...a, url: "https://s/1?sig=c" }], t0 + 11 * 60_000)[0]?.url).toBe(
      "https://s/1?sig=c",
    );
    expect(pinAttachmentUrls(null)).toEqual([]);
  });
});
