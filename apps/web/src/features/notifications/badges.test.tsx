import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { highlightMention } from "../messages/message-row";
import { buildRows } from "../messages/rows";
import { MentionBadge, mentionLabel, UnreadDot } from "./badges";
import { titleFor } from "./use-unread-title";

describe("MentionBadge / UnreadDot", () => {
  it("mostra a contagem com rótulo para leitores de tela", () => {
    render(<MentionBadge count={3} />);
    expect(screen.getByRole("img", { name: "3 menções" })).toHaveTextContent("3");
  });
  it("singular, 99+ e zero", () => {
    const { rerender, container } = render(<MentionBadge count={1} />);
    expect(screen.getByRole("img", { name: "1 menção" })).toBeInTheDocument();
    rerender(<MentionBadge count={120} />);
    expect(screen.getByRole("img", { name: "99+ menções" })).toHaveTextContent("99+");
    rerender(<MentionBadge count={0} />);
    expect(container).toBeEmptyDOMElement();
  });
  it("ponto de não lida tem rótulo", () => {
    render(<UnreadDot label="Mensagens novas" />);
    expect(screen.getByRole("img", { name: "Mensagens novas" })).toBeInTheDocument();
  });
  it("rótulos e título da aba", () => {
    expect(mentionLabel(1, "#geral")).toBe("1 menção em #geral");
    expect(mentionLabel(100, "Alfa")).toBe("99+ menções em Alfa");
    expect(titleFor(0)).toBe("Spook");
    expect(titleFor(7)).toBe("(7) Spook");
    expect(titleFor(300)).toBe("(99+) Spook");
  });
});

describe("highlightMention", () => {
  const marks = (nodes: ReturnType<typeof highlightMention>) =>
    render(<p>{nodes}</p>).container.querySelectorAll("mark");

  it("marca o @username (sem diferenciar maiúsculas) e só ele", () => {
    const m = marks(highlightMention("oi @Ana e @bia, @ana!", "ana"));
    expect([...m].map((e) => e.textContent)).toEqual(["@Ana", "@ana"]);
  });
  it("não marca e-mail, nome maior nem @ colado a palavra", () => {
    expect(marks(highlightMention("ana@x.com @anabela a@ana", "ana"))).toHaveLength(0);
  });
  it("username com ponto e caracteres especiais", () => {
    expect(marks(highlightMention("ei @a.b!", "a.b"))).toHaveLength(1);
  });
});

describe("buildRows: separador 'novas mensagens'", () => {
  const m = (id: string, author = "50") =>
    ({
      id,
      channel_id: "c",
      author: { id: author, username: "x" },
      content: id,
      edited_at: null,
      created_at: "2026-10-31T12:00:00Z",
      attachments: [],
      mention_ids: [],
    }) as never;
  const markers = (rows: ReturnType<typeof buildRows>) =>
    rows.flatMap((r) => (r.kind === "message" && r.marker ? [r.message.id] : []));

  it("entra na primeira mensagem de outra pessoa depois do ponto de leitura, quebrando o agrupamento", () => {
    const rows = buildRows([m("1"), m("2"), m("3")], {
      hasMore: false,
      newAfterId: "1",
      myId: "1",
    });
    expect(markers(rows)).toEqual(["2"]);
    const second = rows.find((r) => r.kind === "message" && r.message.id === "2");
    expect(second?.kind === "message" && second.header).toBe(true);
  });
  it("pula minhas mensagens e não aparece sem ponto de leitura", () => {
    const mine = buildRows([m("1"), m("2", "7"), m("3")], {
      hasMore: false,
      newAfterId: "1",
      myId: "7",
    });
    expect(markers(mine)).toEqual(["3"]);
    expect(markers(buildRows([m("1")], { hasMore: false, newAfterId: null, myId: "7" }))).toEqual(
      [],
    );
    expect(markers(buildRows([m("1")], { hasMore: false }))).toEqual([]);
  });
});
