import { type UserRow, useAdminUsers } from "@spook/shared";
import { keepPreviousData } from "@tanstack/react-query";
import { useState } from "react";
import { type Column, DataTable, type TableState } from "@/features/admin/data-table";
import { formatNumber } from "@/features/admin/format";
import { LiveStatus, PageHeader } from "@/features/admin/ui";
import { useDebounced } from "@/features/admin/use-debounced";
import { formatDateTime } from "@/lib/format";

const COLUMNS: Column<UserRow>[] = [
  { key: "username", label: "Usuário", sort: "username", render: (u) => `@${u.username}` },
  { key: "email", label: "E-mail", sort: "email", render: (u) => u.email },
  {
    key: "guilds_member",
    label: "Servidores",
    sort: "guilds_member",
    align: "right",
    render: (u) => formatNumber(u.guilds_member),
  },
  {
    key: "guilds_owned",
    label: "Possui",
    sort: "guilds_owned",
    align: "right",
    render: (u) => formatNumber(u.guilds_owned),
  },
  {
    key: "messages_sent",
    label: "Mensagens",
    sort: "messages_sent",
    align: "right",
    render: (u) => formatNumber(u.messages_sent),
  },
  {
    key: "last_active_at",
    label: "Última atividade",
    sort: "last_active_at",
    render: (u) => (u.last_active_at ? formatDateTime(u.last_active_at) : "—"),
  },
  {
    key: "created_at",
    label: "Entrou em",
    sort: "created_at",
    render: (u) => formatDateTime(u.created_at),
  },
];

export function AdminUsersPage() {
  const [state, setState] = useState<TableState>({
    q: "",
    sort: "created_at",
    order: "desc",
    page: 1,
  });
  const q = useDebounced(state.q);
  const query = useAdminUsers(
    { q: q || undefined, sort: state.sort, order: state.order, page: state.page },
    { query: { placeholderData: keepPreviousData, staleTime: 10_000 } },
  );
  return (
    <>
      <PageHeader title="Usuários" subtitle="Contas cadastradas, com busca e ordenação.">
        <LiveStatus updatedAt={query.dataUpdatedAt} fetching={query.isFetching} live={false} />
      </PageHeader>
      <DataTable
        caption="Usuários"
        columns={COLUMNS}
        rows={query.data?.items ?? []}
        total={query.data?.total ?? 0}
        pageSize={query.data?.page_size ?? 25}
        state={state}
        onChange={(next) => setState((s) => ({ ...s, ...next }))}
        rowKey={(u) => u.id}
        loading={query.isPending}
        error={query.isError}
        onRetry={() => void query.refetch()}
        searchLabel="Buscar por usuário ou e-mail"
        empty="Nenhum usuário encontrado."
      />
    </>
  );
}
