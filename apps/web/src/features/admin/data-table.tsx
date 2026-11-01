import { ArrowDown, ArrowUp, ArrowUpDown, Search } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type Column<T> = {
  key: string;
  label: string;
  /** Chave aceita pelo backend em `sort`; sem ela a coluna não ordena. */
  sort?: string;
  align?: "right";
  render: (row: T) => ReactNode;
};

export type TableState = { q: string; sort: string; order: "asc" | "desc"; page: number };

/** Tabela ordenável com busca e paginação de 25 em 25 (o estado vive na página, a consulta no servidor). */
export function DataTable<T>({
  caption,
  columns,
  rows,
  total,
  pageSize,
  state,
  onChange,
  rowKey,
  loading,
  error,
  searchLabel,
  empty,
}: {
  caption: string;
  columns: Column<T>[];
  rows: T[];
  total: number;
  pageSize: number;
  state: TableState;
  onChange: (next: Partial<TableState>) => void;
  rowKey: (row: T) => string;
  loading: boolean;
  error: boolean;
  searchLabel: string;
  empty: string;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="rounded-xl border bg-card text-card-foreground shadow-sm">
      <div className="relative border-b p-3">
        <Search
          className="pointer-events-none absolute top-1/2 left-6 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          type="search"
          aria-label={searchLabel}
          placeholder={searchLabel}
          value={state.q}
          onChange={(e) => onChange({ q: e.target.value, page: 1 })}
          className="max-w-sm pl-9"
        />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
            <tr>
              {columns.map((c) => {
                const active = c.sort !== undefined && state.sort === c.sort;
                return (
                  <th
                    key={c.key}
                    scope="col"
                    aria-sort={
                      active ? (state.order === "asc" ? "ascending" : "descending") : undefined
                    }
                    className={cn(
                      "px-3 py-2 font-medium whitespace-nowrap",
                      c.align === "right" && "text-right",
                    )}
                  >
                    {c.sort ? (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 hover:text-foreground"
                        onClick={() =>
                          onChange({
                            sort: c.sort,
                            order: active && state.order === "desc" ? "asc" : "desc",
                            page: 1,
                          })
                        }
                      >
                        {c.label}
                        {active ? (
                          state.order === "asc" ? (
                            <ArrowUp className="size-3" aria-hidden />
                          ) : (
                            <ArrowDown className="size-3" aria-hidden />
                          )
                        ) : (
                          <ArrowUpDown className="size-3 opacity-50" aria-hidden />
                        )}
                      </button>
                    ) : (
                      c.label
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={rowKey(r)} className="border-b last:border-0 hover:bg-accent/40">
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={cn(
                      "px-3 py-2 whitespace-nowrap tabular-nums",
                      c.align === "right" && "text-right",
                    )}
                  >
                    {c.render(r)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error ? (
        <p role="alert" className="p-4 text-sm text-destructive-text">
          Não foi possível carregar a lista. Tente novamente em instantes.
        </p>
      ) : loading ? (
        <output className="block p-4 text-sm text-muted-foreground">Carregando…</output>
      ) : rows.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">{empty}</p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t p-3 text-xs text-muted-foreground">
        <span>
          {total} resultado{total === 1 ? "" : "s"} · página {Math.min(state.page, pages)} de{" "}
          {pages}
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={state.page <= 1}
            onClick={() => onChange({ page: state.page - 1 })}
          >
            Anterior
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={state.page >= pages}
            onClick={() => onChange({ page: state.page + 1 })}
          >
            Próxima
          </Button>
        </div>
      </div>
    </div>
  );
}
