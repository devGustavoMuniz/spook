import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Search,
  SearchX,
} from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export type Column<T> = {
  key: string;
  label: string;
  /** Chave aceita pelo backend em `sort`; sem ela a coluna não ordena. */
  sort?: string;
  align?: "right";
  render: (row: T) => ReactNode;
};

/** Classes comuns das tabelas do painel (cabeçalho fixo, linhas com hover/foco, rolagem com sombras). */
export const adminTable = {
  scroll: "scroll-shadow-x max-h-[65vh] overflow-auto",
  table: "w-full text-left text-sm",
  thead: "sticky top-0 z-[var(--z-sticky)] border-b bg-surface-1 text-xs text-muted-foreground",
  th: "px-3 py-2.5 font-medium whitespace-nowrap",
  tr: "border-b border-border/70 transition-colors last:border-0 hover:bg-accent/50 focus-within:bg-accent/50",
  td: "tabular px-3 py-2.5 whitespace-nowrap",
};

/** Sem linhas: ilustra o motivo (busca sem resultado ou lista vazia) em vez de uma tabela cinza. */
export function TableEmpty({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-sm text-muted-foreground">
      <SearchX aria-hidden className="size-6" />
      <p>{children}</p>
    </div>
  );
}

export function TableSkeleton({ cols }: { cols: number }) {
  return (
    <output className="block">
      {[0, 1, 2, 3, 4, 5].map((r) => (
        <div key={r} className="flex gap-4 border-b border-border/70 px-3 py-3 last:border-0">
          {Array.from({ length: Math.min(cols, 5) }, (_, c) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: esqueleto estático
            <Skeleton key={c} className="h-4 flex-1" />
          ))}
        </div>
      ))}
      <span className="sr-only">Carregando…</span>
    </output>
  );
}

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
  onRetry,
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
  onRetry?: () => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-sm">
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
      <div className={adminTable.scroll}>
        <table className={adminTable.table}>
          <caption className="sr-only">{caption}</caption>
          <thead className={adminTable.thead}>
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
                    className={cn(adminTable.th, c.align === "right" && "text-right")}
                  >
                    {c.sort ? (
                      <button
                        type="button"
                        className={cn(
                          "-mx-1.5 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors hover:bg-accent hover:text-foreground",
                          active && "text-foreground",
                        )}
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
                            <ArrowUp className="size-3 text-brand-text" aria-hidden />
                          ) : (
                            <ArrowDown className="size-3 text-brand-text" aria-hidden />
                          )
                        ) : (
                          <ArrowUpDown className="size-3 opacity-40" aria-hidden />
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
              <tr key={rowKey(r)} className={adminTable.tr}>
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={cn(adminTable.td, c.align === "right" && "text-right")}
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
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 p-4 text-sm text-destructive-text"
        >
          <CircleAlert className="size-4 shrink-0" aria-hidden />
          <span>Não foi possível carregar a lista. Tente novamente em instantes.</span>
          {onRetry ? (
            <Button size="sm" variant="outline" onClick={onRetry}>
              Tentar de novo
            </Button>
          ) : null}
        </div>
      ) : loading ? (
        <TableSkeleton cols={columns.length} />
      ) : rows.length === 0 ? (
        <TableEmpty>{empty}</TableEmpty>
      ) : null}
      <div className="tabular flex flex-wrap items-center justify-between gap-2 border-t border-border bg-surface-1 p-3 text-xs text-muted-foreground">
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
            <ChevronLeft aria-hidden /> Anterior
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={state.page >= pages}
            onClick={() => onChange({ page: state.page + 1 })}
          >
            Próxima <ChevronRight aria-hidden />
          </Button>
        </div>
      </div>
    </div>
  );
}
