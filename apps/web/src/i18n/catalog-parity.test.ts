import { describe, expect, it } from "vitest";
import { en } from "./messages/en";
import { ptBR } from "./messages/pt-BR";
import type { Message } from "./types";

const placeholders = (m: Message): string[] => {
  const texts = typeof m === "string" ? [m] : Object.values(m);
  const set = new Set<string>();
  for (const x of texts) for (const p of x.matchAll(/\{(\w+)\}/g)) set.add(p[1] as string);
  return [...set].sort();
};
const forms = (m: Message) => (typeof m === "string" ? "string" : "plural");

describe("paridade pt-BR x en", () => {
  const ptKeys = Object.keys(ptBR).sort();
  const enKeys = Object.keys(en).sort();

  it("en tem exatamente as mesmas chaves de pt-BR", () => {
    expect(enKeys.filter((k) => !(k in ptBR))).toEqual([]);
    expect(ptKeys.filter((k) => !(k in en))).toEqual([]);
  });

  it("mesmos placeholders e mesma forma (texto simples ou plural) em cada chave", () => {
    const bad: string[] = [];
    for (const k of ptKeys) {
      const a = (ptBR as Record<string, Message>)[k] as Message;
      const b = (en as Record<string, Message>)[k] as Message;
      if (!b) continue;
      if (forms(a) !== forms(b)) bad.push(`${k}: forma diferente`);
      else if (placeholders(a).join() !== placeholders(b).join())
        bad.push(`${k}: placeholders ${placeholders(a)} x ${placeholders(b)}`);
      const texts = typeof b === "string" ? [b] : Object.values(b);
      if (texts.some((x) => x.trim() === "")) bad.push(`${k}: vazio`);
      if (typeof b === "object" && !b.other) bad.push(`${k}: plural sem "other"`);
    }
    expect(bad).toEqual([]);
  });
});
