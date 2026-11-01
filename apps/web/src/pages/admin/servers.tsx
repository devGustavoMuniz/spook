import { type ServerRow, useAdminServers } from "@spook/shared";
import { keepPreviousData } from "@tanstack/react-query";
import { useState } from "react";
import { type Column, DataTable, type TableState } from "@/features/admin/data-table";
import { formatNumber } from "@/features/admin/format";
import { LiveStatus, PageHeader } from "@/features/admin/ui";
import { useDebounced } from "@/features/admin/use-debounced";
import { formatDateTime } from "@/lib/format";

const COLUMNS: Column<ServerRow>[] = [
  { key: "name", label: "Servidor", sort: "name", render: (s) => s.name },
  { key: "owner", label: "Dono", sort: "owner", render: (s) => `@${s.owner}` },
  {
    key: "members",
    label: "Membros",
    sort: "members",
    align: "right",
    render: (s) => formatNumber(s.members),
  },
  {
    key: "channels",
    label: "Canais",
    sort: "channels",
    align: "right",
    render: (s) => formatNumber(s.channels),
  },
  {
    key: "messages",
    label: "Mensagens",
    sort: "messages",
    align: "right",
    render: (s) => formatNumber(s.messages),
  },
  {
    key: "invites_active",
    label: "Convites ativos",
    sort: "invites_active",
    align: "right",
    render: (s) => formatNumber(s.invites_active),
  },
  {
    key: "created_at",
    label: "Criado em",
    sort: "created_at",
    render: (s) => formatDateTime(s.created_at),
  },
];

export function AdminServersPage() {
  const [state, setState] = useState<TableState>({
    q: "",
    sort: "created_at",
    order: "desc",
    page: 1,
  });
  const q = useDebounced(state.q);
  const query = useAdminServers(
    { q: q || undefined, sort: state.sort, order: state.order, page: state.page },
    { query: { placeholderData: keepPreviousData, staleTime: 10_000 } },
  );
  return (
    <>
      <PageHeader title="Servidores" subtitle="Servidores criados, com busca e ordenação.">
        <LiveStatus updatedAt={query.dataUpdatedAt} fetching={query.isFetching} live={false} />
      </PageHeader>
      <DataTable
        caption="Servidores"
        columns={COLUMNS}
        rows={query.data?.items ?? []}
        total={query.data?.total ?? 0}
        pageSize={query.data?.page_size ?? 25}
        state={state}
        onChange={(next) => setState((s) => ({ ...s, ...next }))}
        rowKey={(s) => s.id}
        loading={query.isPending}
        error={query.isError}
        searchLabel="Buscar por servidor ou dono"
        empty="Nenhum servidor encontrado."
      />
    </>
  );
}
