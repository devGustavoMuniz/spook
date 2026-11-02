import { describe, expect, it } from "vitest";
import {
  applyMention,
  filterMentionOptions,
  findMentionQuery,
  type MentionOption,
} from "./mentions";

const o = (handle: string, label = handle): MentionOption => ({
  id: handle,
  handle,
  label,
  kind: "user",
});

describe("findMentionQuery", () => {
  it("acha o @ sob o cursor, no início, no meio e depois de quebra de linha", () => {
    expect(findMentionQuery("@an", 3)).toEqual({ start: 0, end: 3, query: "an" });
    expect(findMentionQuery("oi @ana", 7)).toEqual({ start: 3, end: 7, query: "ana" });
    expect(findMentionQuery("oi\n@", 4)).toEqual({ start: 3, end: 4, query: "" });
    expect(findMentionQuery("(@bia", 5)?.query).toBe("bia");
  });

  it("o fim do token inclui o que está depois do cursor", () => {
    expect(findMentionQuery("@ana_silva", 3)).toEqual({ start: 0, end: 10, query: "an" });
  });

  it("não é menção: e-mail, @ colado a palavra, espaço entre o @ e o cursor, sem @", () => {
    expect(findMentionQuery("a@b.com", 7)).toBeNull();
    expect(findMentionQuery("foo@bar", 7)).toBeNull();
    expect(findMentionQuery("@@ana", 5)).toBeNull();
    expect(findMentionQuery("@ana oi", 7)).toBeNull();
    expect(findMentionQuery("oi", 2)).toBeNull();
    expect(findMentionQuery("", 0)).toBeNull();
  });
});

describe("filterMentionOptions", () => {
  const list = [
    o("ana", "Ana Souza"),
    o("bruno", "Ana Paula"),
    o("carla_ana", "Carla"),
    o("davi", "Davi Lúcio"),
  ];

  it("consulta vazia lista todos (até o limite)", () => {
    expect(filterMentionOptions(list, "")).toHaveLength(4);
    expect(filterMentionOptions(list, "", 2)).toHaveLength(2);
  });

  it("ordena prefixo do username, prefixo do nome e depois 'contém'", () => {
    expect(filterMentionOptions(list, "ana").map((x) => x.handle)).toEqual([
      "ana",
      "bruno",
      "carla_ana",
    ]);
  });

  it("ignora acento e maiúsculas e casa o nome de exibição", () => {
    expect(filterMentionOptions(list, "LUCIO").map((x) => x.handle)).toEqual(["davi"]);
    expect(filterMentionOptions(list, "paula").map((x) => x.handle)).toEqual(["bruno"]);
  });

  it("sem resultado devolve vazio", () => {
    expect(filterMentionOptions(list, "zzz")).toEqual([]);
  });

  it("aceita outros tipos de menção (cargo, everyone) sem mudar a lógica", () => {
    const extra: MentionOption[] = [
      { id: "r1", handle: "moderadores", label: "Moderadores", kind: "role" },
      { id: "e", handle: "everyone", label: "Todos", kind: "everyone" },
    ];
    expect(filterMentionOptions(extra, "mod")[0]?.kind).toBe("role");
    expect(filterMentionOptions(extra, "every")[0]?.kind).toBe("everyone");
  });
});

describe("applyMention", () => {
  it("troca a consulta e põe o cursor depois do espaço", () => {
    const text = "oi @an";
    const q = findMentionQuery(text, 6);
    if (!q) throw new Error("sem consulta");
    expect(applyMention(text, q, "ana")).toEqual({ text: "oi @ana ", caret: 8 });
  });

  it("no meio do texto não duplica o espaço", () => {
    const text = "oi @an tudo bem";
    const q = findMentionQuery(text, 6);
    if (!q) throw new Error("sem consulta");
    expect(applyMention(text, q, "ana")).toEqual({ text: "oi @ana tudo bem", caret: 8 });
  });
});
