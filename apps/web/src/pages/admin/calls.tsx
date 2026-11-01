import { useAdminCalls } from "@spook/shared";
import { keepPreviousData } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { formatDuration, formatNumber } from "@/features/admin/format";
import { ErrorNote, LiveStatus, PageHeader, StatCard, Unavailable } from "@/features/admin/ui";
import { useDebounced } from "@/features/admin/use-debounced";

export function AdminCallsPage() {
  const [text, setText] = useState("");
  const q = useDebounced(text);
  const query = useAdminCalls(
    { q: q || undefined },
    { query: { refetchInterval: 5_000, placeholderData: keepPreviousData, staleTime: 0 } },
  );
  const d = query.data;
  const rooms = d?.rooms ?? [];
  return (
    <>
      <PageHeader title="Chamadas" subtitle="Lido ao vivo do servidor LiveKit.">
        <LiveStatus
          updatedAt={query.dataUpdatedAt}
          fetching={query.isFetching}
          failed={query.isError}
        />
      </PageHeader>
      {query.isError ? <ErrorNote>Não foi possível carregar as chamadas.</ErrorNote> : null}
      {d && !d.summary.available ? (
        <Unavailable title="Chamadas" reason={d.summary.reason} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Chamadas em andamento"
            value={d ? formatNumber(d.summary.ongoing) : "—"}
          />
          <StatCard label="Pessoas em chamadas" value={d ? formatNumber(d.summary.people) : "—"} />
          <StatCard label="Câmeras ligadas" value={d ? formatNumber(d.summary.cameras) : "—"} />
          <StatCard
            label="Compartilhamentos de tela"
            value={d ? formatNumber(d.summary.screens) : "—"}
          />
        </div>
      )}
      <div className="mt-6 rounded-xl border bg-card text-card-foreground shadow-sm">
        <div className="relative border-b p-3">
          <Search
            className="pointer-events-none absolute top-1/2 left-6 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            aria-label="Buscar por servidor, canal ou pessoa"
            placeholder="Buscar por servidor, canal ou pessoa"
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="max-w-sm pl-9"
          />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Salas de voz ativas</caption>
            <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
              <tr>
                {["Servidor", "Canal", "Pessoas", "Câmeras", "Telas", "Duração"].map((h) => (
                  <th key={h} scope="col" className="px-3 py-2 font-medium whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rooms.map((r) => (
                <tr key={r.channel_id} className="border-b last:border-0 hover:bg-accent/40">
                  <td className="px-3 py-2">{r.server || "Conversa direta"}</td>
                  <td className="px-3 py-2">{r.channel}</td>
                  <td className="px-3 py-2">
                    <span className="tabular-nums">{r.people?.length ?? 0}</span>{" "}
                    <span className="text-muted-foreground">
                      {(r.people ?? []).map((p) => `@${p}`).join(", ")}
                    </span>
                  </td>
                  <td className="px-3 py-2 tabular-nums">{r.cameras}</td>
                  <td className="px-3 py-2 tabular-nums">{r.screens}</td>
                  <td className="px-3 py-2 tabular-nums">
                    {r.started_at ? formatDuration(r.duration_seconds) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {query.isPending ? (
          <output className="block p-4 text-sm text-muted-foreground">Carregando…</output>
        ) : rooms.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            {q ? "Nenhuma sala corresponde à busca." : "Nenhuma chamada em andamento."}
          </p>
        ) : null}
      </div>
    </>
  );
}
