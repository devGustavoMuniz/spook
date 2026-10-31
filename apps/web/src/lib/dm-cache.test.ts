import type { ChannelPayload } from "@spook/shared";
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";
import { dm, recipient } from "@/test/fixtures";
import { bumpDM, dmsOf, removeDM, setDMs, sortByActivity, upsertDM } from "./dm-cache";

let qc: QueryClient;
const ids = () => dmsOf(qc).map((c) => c.id);
const a = recipient("1", "ana");
const b = recipient("2", "bia");
const c = recipient("3", "caio");

beforeEach(() => {
  qc = new QueryClient();
});

describe("cache de DMs", () => {
  it("ordena por atividade: last_message_id, ou o id da conversa se ainda não há mensagens", () => {
    const list: ChannelPayload[] = [
      dm("100", [a, b], { last_message_id: "500" }),
      dm("200", [a, c]), // sem mensagens: vale o id do canal (200)
      dm("300", [a, b], { last_message_id: "900" }),
    ];
    expect(sortByActivity(list).map((x) => x.id)).toEqual(["300", "100", "200"]);
  });

  it("compara ids como números (Snowflake de 19 dígitos), não como texto", () => {
    const list = [dm("1", [a], { last_message_id: "9" }), dm("2", [a], { last_message_id: "10" })];
    expect(sortByActivity(list).map((x) => x.id)).toEqual(["2", "1"]);
  });

  it("setDMs substitui a lista (READY); null vira lista vazia", () => {
    setDMs(qc, [dm("100", [a, b])]);
    setDMs(qc, [dm("200", [a, c])]);
    expect(ids()).toEqual(["200"]);
    setDMs(qc, null);
    expect(ids()).toEqual([]);
  });

  it("upsertDM cria ou substitui sem duplicar (participantes novos entram)", () => {
    upsertDM(qc, dm("100", [a, b], { type: 4, owner_id: "1" }));
    upsertDM(qc, dm("100", [a, b, c], { type: 4, owner_id: "1" }));
    expect(ids()).toEqual(["100"]);
    expect(dmsOf(qc)[0]?.recipients).toHaveLength(3);
  });

  it("removeDM tira a conversa", () => {
    setDMs(qc, [dm("100", [a, b]), dm("200", [a, c])]);
    removeDM(qc, "100");
    expect(ids()).toEqual(["200"]);
  });

  it("bumpDM sobe a conversa com mensagem nova e não regride com id antigo", () => {
    setDMs(qc, [
      dm("100", [a, b], { last_message_id: "500" }),
      dm("200", [a, c], { last_message_id: "600" }),
    ]);
    expect(ids()).toEqual(["200", "100"]);
    bumpDM(qc, "100", "700");
    expect(ids()).toEqual(["100", "200"]);
    bumpDM(qc, "100", "650"); // mais antigo que o atual: ignora
    expect(dmsOf(qc)[0]?.last_message_id).toBe("700");
    bumpDM(qc, "inexistente", "999"); // canal que não é DM: nada acontece
    expect(ids()).toEqual(["100", "200"]);
  });
});
