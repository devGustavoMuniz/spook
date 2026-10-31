import type { MessagePayload } from "@spook/shared";

const AUTHORS = Array.from({ length: 24 }, (_, i) => ({
  id: String(9000 + i),
  username: `perf${i}`,
  display_name: `Pessoa ${i + 1}`,
}));

const WORDS = "spook canal mensagem teste desempenho lista virtual rolagem fluida servidor".split(
  " ",
);

/**
 * Mensagens falsas só para medir a lista (Fase B): `?perf=10000` em dev. Alturas variam (1 a 6
 * linhas), com sequências do mesmo autor para exercitar o agrupamento. IDs crescentes e estáveis.
 */
export function makePerfMessages(count: number, channelId = "perf"): MessagePayload[] {
  const start = Date.now() - count * 45_000;
  const out: MessagePayload[] = [];
  let seed = 7;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  let author = 0;
  for (let i = 0; i < count; i++) {
    if (rnd() < 0.35) author = Math.floor(rnd() * AUTHORS.length);
    const lines = 1 + Math.floor(rnd() * rnd() * 6);
    const content = Array.from({ length: lines }, () =>
      Array.from(
        { length: 3 + Math.floor(rnd() * 14) },
        () => WORDS[Math.floor(rnd() * WORDS.length)],
      ).join(" "),
    ).join("\n");
    out.push({
      id: String(1_000_000 + i),
      channel_id: channelId,
      author: AUTHORS[author] as (typeof AUTHORS)[number],
      content: `#${i + 1} ${content}`,
      created_at: new Date(start + i * 45_000).toISOString(),
      edited_at: rnd() < 0.03 ? new Date(start + i * 45_000 + 5000).toISOString() : null,
      attachments: [],
      mention_ids: [],
      reply_to: null,
      pinned: false,
    });
  }
  return out;
}
