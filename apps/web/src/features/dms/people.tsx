import { getListGuildMembersQueryOptions, useGetMe, useListGuilds } from "@spook/shared";
import { useQueries } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Avatar } from "@/components/avatar";
import { Input } from "@/components/ui/input";
import { memberName } from "@/features/members/use-members";

export type Person = { id: string; name: string; username: string; avatarUrl?: string };

/**
 * Quem posso chamar para uma conversa: os membros dos meus servidores (a regra do servidor é
 * "compartilhar um servidor"), sem repetidos e sem mim. Reaproveita o cache da lista de membros.
 */
export function useGuildPeople(exclude: ReadonlySet<string> = new Set()) {
  const { data: me } = useGetMe();
  const guilds = useListGuilds();
  const results = useQueries({
    queries: (guilds.data ?? []).map((g) => getListGuildMembersQueryOptions(g.id, { limit: 1000 })),
  });
  const pending = guilds.isPending || results.some((r) => r.isPending);
  const data = results.map((r) => r.data);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `data` é novo a cada render; as respostas mudam por referência
  const people = useMemo(() => {
    const map = new Map<string, Person>();
    for (const d of data)
      for (const m of d?.members ?? []) {
        if (m.user_id === me?.id || exclude.has(m.user_id) || map.has(m.user_id)) continue;
        map.set(m.user_id, {
          id: m.user_id,
          name: memberName(m),
          username: m.username,
          avatarUrl: m.avatar_url,
        });
      }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  }, [results.map((r) => r.dataUpdatedAt).join(","), me?.id, exclude]);
  return { people, pending };
}

/** Lista com busca e caixas de seleção; `max` limita quantas pessoas podem ficar marcadas. */
export function PeoplePicker({
  people,
  pending,
  selected,
  max,
  onToggle,
}: {
  people: Person[];
  pending: boolean;
  selected: ReadonlySet<string>;
  max: number;
  onToggle: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLocaleLowerCase("pt-BR");
  const shown = q
    ? people.filter(
        (p) =>
          p.name.toLocaleLowerCase("pt-BR").includes(q) || p.username.toLowerCase().includes(q),
      )
    : people;
  return (
    <div className="flex flex-col gap-2">
      <Input
        type="search"
        aria-label="Buscar pessoas"
        placeholder="Buscar pessoas"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <ul className="max-h-56 overflow-y-auto rounded-md border" aria-label="Pessoas">
        {pending ? (
          <li className="p-3 text-sm text-muted-foreground">Carregando pessoas…</li>
        ) : shown.length === 0 ? (
          <li className="p-3 text-sm text-muted-foreground">
            {people.length === 0
              ? "Ninguém disponível: só dá para conversar com quem está em um servidor com você."
              : "Ninguém encontrado."}
          </li>
        ) : null}
        {shown.map((p) => {
          const checked = selected.has(p.id);
          return (
            <li key={p.id}>
              <label className="flex cursor-pointer items-center gap-3 px-3 py-1.5 hover:bg-accent">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={checked}
                  disabled={!checked && selected.size >= max}
                  onChange={() => onToggle(p.id)}
                />
                <Avatar url={p.avatarUrl} name={p.name} size={24} />
                <span className="min-w-0 flex-1 truncate text-sm">{p.name}</span>
                <span className="truncate text-xs text-muted-foreground">@{p.username}</span>
              </label>
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {selected.size} de {max} selecionadas
      </p>
    </div>
  );
}

/** Estado de seleção para o `PeoplePicker`. */
export function useSelection() {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  return {
    selected,
    toggle: (id: string) =>
      setSelected((s) => {
        const next = new Set(s);
        if (!next.delete(id)) next.add(id);
        return next;
      }),
    clear: () => setSelected(new Set()),
  };
}
