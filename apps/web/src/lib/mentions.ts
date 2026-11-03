// Autocompletar de menção `@`: acha o trecho `@consulta` sob o cursor e ordena as sugestões.
// A fonte de dados é uma lista de `MentionOption`: usuários, cargos e `@everyone`/`@here` (estes só aparecem
// para quem pode mencioná-los: MENTION_EVERYONE no canal ou cargo mencionável).

export type MentionOption = {
  /** Chave estável (id do usuário, do cargo...). */
  id: string;
  /** Texto inserido depois do `@` (username, nome do cargo, `everyone`). */
  handle: string;
  /** Nome mostrado (nome de exibição; cai no handle). */
  label: string;
  avatarUrl?: string;
  /** Cor do cargo (`#rrggbb`), quando `kind` é `role`. */
  color?: string;
  /** Texto de apoio da opção (ex.: "Notifica todos os que veem o canal"). */
  hint?: string;
  kind: "user" | "role" | "everyone";
};

/** O que o cliente precisa saber do servidor para tratar menções em massa. */
export type MentionContext = {
  /** Cargos do servidor (sem o @everyone). */
  roles: readonly { id: string; name: string; color?: string }[];
  /** IDs dos meus cargos. */
  myRoleIds: readonly string[];
  /** "Suprimir @everyone e @here" ligado neste servidor. */
  suppressEveryone: boolean;
};

/**
 * A mensagem me notifica por menção em massa? Cargo meu vale sempre; `@everyone`/`@here` valem, a menos que eu
 * tenha suprimido (o servidor aplica a mesma regra ao somar o contador). Mensagens minhas não contam.
 */
export function bulkMentionsMe(
  m: {
    author: { id: string };
    mention_everyone?: boolean;
    mention_here?: boolean;
    mention_roles?: readonly string[] | null;
  },
  myId: string,
  ctx?: Pick<MentionContext, "myRoleIds" | "suppressEveryone">,
): boolean {
  if (!ctx || m.author.id === myId) return false;
  if ((m.mention_roles ?? []).some((r) => ctx.myRoleIds.includes(r))) return true;
  return !!(m.mention_everyone || m.mention_here) && !ctx.suppressEveryone;
}

/** Opções fixas de menção em massa, para o autocompletar de quem tem MENTION_EVERYONE. */
export const EVERYONE_OPTIONS: readonly MentionOption[] = [
  {
    id: "everyone",
    handle: "everyone",
    label: "everyone",
    kind: "everyone",
    hint: "Todos que veem este canal",
  },
  {
    id: "here",
    handle: "here",
    label: "here",
    kind: "everyone",
    hint: "Só quem está online",
  },
];

export type MentionQuery = { start: number; end: number; query: string };

/** Mesma regra do servidor para o que é uma menção: o @ não vem colado a letra, dígito, `_`, `.` ou `@`. */
const LEAD = /[A-Za-z0-9_.@]/;
const CHARS = /[A-Za-z0-9_.]/;

/**
 * Se o cursor está dentro de um `@consulta` (sem espaço entre o @ e o cursor), devolve onde ele começa e termina.
 * `end` é o fim do token (inclui o que vem depois do cursor, para a troca não deixar resto).
 */
export function findMentionQuery(text: string, caret: number): MentionQuery | null {
  let i = caret - 1;
  while (i >= 0 && CHARS.test(text.charAt(i))) i--;
  if (i < 0 || text.charAt(i) !== "@") return null;
  if (i > 0 && LEAD.test(text.charAt(i - 1))) return null;
  let end = caret;
  while (end < text.length && CHARS.test(text.charAt(end))) end++;
  return { start: i, end, query: text.slice(i + 1, caret) };
}

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

/** Pontuação: prefixo do handle > prefixo do nome > contém no handle > contém no nome. 0 = não casa. */
function score(o: MentionOption, q: string): number {
  if (q === "") return 1;
  const h = fold(o.handle);
  const l = fold(o.label);
  if (h.startsWith(q)) return 4;
  if (l.startsWith(q) || l.split(/\s+/).some((w) => w.startsWith(q))) return 3;
  if (h.includes(q)) return 2;
  if (l.includes(q)) return 1;
  return 0;
}

/** Filtra por username e nome de exibição (sem acento, sem diferenciar maiúsculas), melhores primeiro. */
export function filterMentionOptions(
  options: readonly MentionOption[],
  query: string,
  limit = 8,
): MentionOption[] {
  const q = fold(query);
  return options
    .map((o, i) => ({ o, s: score(o, q), i }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.o.handle.localeCompare(b.o.handle) || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.o);
}

/** Troca o `@consulta` por `@handle ` e devolve o texto novo e a posição do cursor. */
export function applyMention(
  text: string,
  q: MentionQuery,
  handle: string,
): { text: string; caret: number } {
  const insert = `@${handle} `;
  const after = text.slice(q.end).replace(/^ /, "");
  return { text: text.slice(0, q.start) + insert + after, caret: q.start + insert.length };
}
