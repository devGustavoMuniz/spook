import { useAdminCalls } from "@spook/shared";
import { keepPreviousData } from "@tanstack/react-query";
import { Camera, MonitorUp, Phone, Search, Users } from "lucide-react";
import { useState } from "react";
import { type BarItem, BarList } from "@/components/charts";
import { Input } from "@/components/ui/input";
import { adminTable, TableEmpty, TableSkeleton } from "@/features/admin/data-table";
import { formatDuration, formatDurationShort, formatNumber } from "@/features/admin/format";
import {
  ErrorNote,
  LiveStatus,
  PageHeader,
  Section,
  StatCard,
  Unavailable,
} from "@/features/admin/ui";
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
  const roomName = (r: (typeof rooms)[number]) => `${r.server || "Conversa direta"} · ${r.channel}`;
  const peopleBars: BarItem[] = rooms.map((r) => ({
    key: r.channel_id,
    label: roomName(r),
    value: r.people?.length ?? 0,
    detail: `${r.cameras} câmeras · ${r.screens} telas`,
  }));
  const durationBars: BarItem[] = rooms
    .filter((r) => r.started_at)
    .map((r) => ({
      key: r.channel_id,
      label: roomName(r),
      value: r.duration_seconds,
      display: formatDurationShort(r.duration_seconds),
    }));
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
            icon={Phone}
            label="Chamadas em andamento"
            value={d ? formatNumber(d.summary.ongoing) : "—"}
            loading={!d}
          />
          <StatCard
            icon={Users}
            label="Pessoas em chamadas"
            value={d ? formatNumber(d.summary.people) : "—"}
            loading={!d}
          />
          <StatCard
            icon={Camera}
            label="Câmeras ligadas"
            value={d ? formatNumber(d.summary.cameras) : "—"}
            loading={!d}
          />
          <StatCard
            icon={MonitorUp}
            label="Compartilhamentos de tela"
            value={d ? formatNumber(d.summary.screens) : "—"}
            loading={!d}
          />
        </div>
      )}
      {rooms.length > 0 ? (
        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          <Section title="Pessoas por sala" hint="Quem está em cada sala agora">
            <BarList title="Pessoas por sala" items={peopleBars} valueHeader="Pessoas" />
          </Section>
          <Section title="Duração das chamadas" hint="Tempo desde que a sala foi aberta">
            <BarList
              title="Duração das chamadas"
              items={durationBars}
              valueHeader="Duração"
              emptyText="Nenhuma sala com início conhecido."
            />
          </Section>
        </div>
      ) : null}
      <div className="mt-6 overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-sm">
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
        <div className={adminTable.scroll}>
          <table className={adminTable.table}>
            <caption className="sr-only">Salas de voz ativas</caption>
            <thead className={adminTable.thead}>
              <tr>
                {["Servidor", "Canal", "Pessoas", "Câmeras", "Telas", "Duração"].map((h) => (
                  <th key={h} scope="col" className={adminTable.th}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rooms.map((r) => (
                <tr key={r.channel_id} className={adminTable.tr}>
                  <td className={adminTable.td}>{r.server || "Conversa direta"}</td>
                  <td className={adminTable.td}>{r.channel}</td>
                  <td className={adminTable.td}>
                    <span className="tabular-nums">{r.people?.length ?? 0}</span>{" "}
                    <span className="text-muted-foreground">
                      {(r.people ?? []).map((p) => `@${p}`).join(", ")}
                    </span>
                  </td>
                  <td className={adminTable.td}>{r.cameras}</td>
                  <td className={adminTable.td}>{r.screens}</td>
                  <td className={adminTable.td}>
                    {r.started_at ? formatDuration(r.duration_seconds) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {query.isPending ? (
          <TableSkeleton cols={6} />
        ) : rooms.length === 0 ? (
          <TableEmpty>
            {q ? "Nenhuma sala corresponde à busca." : "Nenhuma chamada em andamento."}
          </TableEmpty>
        ) : null}
      </div>
    </>
  );
}
