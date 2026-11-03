import type { MessagePayload } from "@spook/shared";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  flattenPages,
  type MessagePages,
  removeMessage,
  replaceMessage,
  setPinned,
  truncateRunes,
} from "./message-cache";
import { applyPinUpdate, pinsKey, removePinned } from "./pins-cache";
import { queryKeys } from "./queryKeys";

const CH = "c1";
const base = (id: string, extra: Partial<MessagePayload> = {}): MessagePayload => ({
  id,
  channel_id: CH,
  author: { id: "50", username: "bia" },
  content: `m${id}`,
  edited_at: null,
  created_at: "2026-10-31T12:00:00Z",
  attachments: [],
  mention_ids: [],
  kind: "default",
  mention_everyone: false,
  mention_here: false,
  mention_roles: [],
  reply_to: null,
  pinned: false,
  ...extra,
});
const reply = (id: string): NonNullable<MessagePayload["reply_to"]> => ({
  id,
  author: { id: "50", username: "bia" },
  content: `m${id}`,
  has_attachments: false,
  deleted: false,
});

function qcWith(msgs: MessagePayload[]) {
  const qc = new QueryClient();
  const data: MessagePages = {
    pages: [{ messages: [...msgs].reverse(), has_more: false }],
    pageParams: [undefined],
  };
  qc.setQueryData(queryKeys.messages(CH), data);
  return qc;
}
const history = (qc: QueryClient) =>
  flattenPages(qc.getQueryData<MessagePages>(queryKeys.messages(CH)));

describe("truncateRunes", () => {
  it("corta em 100 caracteres sem partir emoji", () => {
    expect(truncateRunes("a".repeat(150))).toHaveLength(100);
    const s = truncateRunes("😀".repeat(120));
    expect(Array.from(s)).toHaveLength(100);
    expect(truncateRunes("curto")).toBe("curto");
  });
});

describe("citação acompanha a original", () => {
  it("apagar a original marca deleted e limpa o trecho (e remove a própria linha)", () => {
    const qc = qcWith([base("1"), base("2", { reply_to: reply("1") }), base("3")]);
    removeMessage(qc, CH, "1");
    const h = history(qc);
    expect(h.map((m) => m.id)).toEqual(["2", "3"]);
    expect(h[0]?.reply_to).toMatchObject({ id: "1", deleted: true, content: "" });
  });

  it("editar a original atualiza o trecho; anexos ligam has_attachments", () => {
    const qc = qcWith([base("1"), base("2", { reply_to: reply("1") })]);
    replaceMessage(qc, CH, base("1", { content: "novo" }));
    expect(history(qc)[1]?.reply_to).toMatchObject({ content: "novo", deleted: false });
  });

  it("setPinned só mexe na mensagem indicada", () => {
    const qc = qcWith([base("1"), base("2")]);
    setPinned(qc, CH, "2", true);
    expect(history(qc).map((m) => m.pinned)).toEqual([false, true]);
  });
});

describe("cache de fixadas", () => {
  const seed = (qc: QueryClient, ids: string[]) =>
    qc.setQueryData(pinsKey(CH), { messages: ids.map((id) => base(id, { pinned: true })) });
  const ids = (qc: QueryClient) =>
    (qc.getQueryData<{ messages: MessagePayload[] }>(pinsKey(CH))?.messages ?? []).map((m) => m.id);

  it("fixada entra no topo; já presente é atualizada no lugar; desafixada sai", () => {
    const qc = new QueryClient();
    seed(qc, ["1"]);
    applyPinUpdate(qc, CH, base("2", { pinned: true }));
    expect(ids(qc)).toEqual(["2", "1"]);
    applyPinUpdate(qc, CH, base("1", { pinned: true, content: "editada" }));
    expect(ids(qc)).toEqual(["2", "1"]);
    applyPinUpdate(qc, CH, base("2", { pinned: false }));
    expect(ids(qc)).toEqual(["1"]);
  });

  it("sem a lista carregada não cria cache; apagada sai", () => {
    const qc = new QueryClient();
    applyPinUpdate(qc, CH, base("1", { pinned: true }));
    expect(qc.getQueryData(pinsKey(CH))).toBeUndefined();
    seed(qc, ["1", "2"]);
    removePinned(qc, CH, "1");
    expect(ids(qc)).toEqual(["2"]);
  });
});
