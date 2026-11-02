import { describe, expect, it } from "vitest";
import { messages } from "@/test/fixtures";
import { buildRows, type MessageRowData } from "./rows";

const msgs = (n: number, author = "50") => messages("c", n, 1000, author);
const rows = (list: ReturnType<typeof msgs>, extra = {}) =>
  buildRows(list, { hasMore: true, ...extra }).filter(
    (r): r is MessageRowData => r.kind === "message",
  );

describe("buildRows", () => {
  it("agrupa mensagens seguidas do mesmo autor dentro da janela", () => {
    const r = rows(msgs(4));
    expect(r.map((x) => x.header)).toEqual([true, false, false, false]);
  });

  it("quebra o grupo por outro autor, por intervalo longo, por dia novo e por resposta", () => {
    const [a, b, c, d, e] = msgs(5);
    if (!a || !b || !c || !d || !e) throw new Error("fixture");
    b.author = { id: "60", username: "caio" };
    c.created_at = new Date(Date.parse(b.created_at) + 8 * 60_000).toISOString();
    c.author = b.author;
    d.created_at = new Date(Date.parse(c.created_at) + 60_000).toISOString();
    d.author = b.author;
    d.reply_to = {
      id: "1",
      author: { id: "50", username: "bia" },
      content: "x",
      deleted: false,
      has_attachments: false,
    };
    e.created_at = new Date(Date.parse(d.created_at) + 24 * 3_600_000).toISOString();
    e.author = b.author;
    const r = rows([a, b, c, d, e]);
    expect(r.map((x) => x.header)).toEqual([true, true, true, true, true]);
    expect(r[4]?.day).toBeTruthy();
    expect(r[1]?.day).toBeUndefined();
  });

  it("separador 'novas mensagens' entra na primeira de outra pessoa depois do ponto de leitura", () => {
    const r = rows(msgs(4), { newAfterId: "1001", myId: "1" });
    expect(r.map((x) => !!x.marker)).toEqual([false, false, true, false]);
    // o marcador também quebra o grupo (a mensagem ganha cabeçalho)
    expect(r[2]?.header).toBe(true);
  });

  it("sem mais histórico, a primeira linha é o início do canal", () => {
    expect(buildRows(msgs(1), { hasMore: false })[0]?.kind).toBe("start");
  });
});
