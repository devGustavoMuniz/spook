import {
  type AdminListEntitlementsState,
  type AdminListEntitlementsTier,
  type AdminListRedeemCodesState,
  type AdminListRedeemCodesTier,
  type CodePayload,
  type GrantPayload,
  isApiError,
  type NewCodePayload,
  useAdminCreateRedeemCodes,
  useAdminGrantEntitlement,
  useAdminListEntitlements,
  useAdminListRedeemCodes,
  useAdminRevokeEntitlementGrant,
  useAdminUsers,
} from "@spook/shared";
import { keepPreviousData, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, KeyRound, Search, UserRound, X } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { type Column, DataTable, type TableState } from "@/features/admin/data-table";
import { ErrorNote, LiveStatus, PageHeader, Section } from "@/features/admin/ui";
import { useDebounced } from "@/features/admin/use-debounced";
import { formatDateTime } from "@/lib/format";

type Tier = "nitro" | "nitro_plus";

const TIER_LABEL: Record<Tier, string> = { nitro: "Nitro", nitro_plus: "Nitro+" };
const SOURCE_LABEL: Record<string, string> = {
  admin: "Administração",
  code: "Código de resgate",
  payment: "Pagamento",
};
const CODE_STATE_LABEL = { unused: "Não usado", used: "Usado", expired: "Vencido" } as const;
const CODE_STATE_VARIANT = { unused: "success", used: "secondary", expired: "warning" } as const;

const selectClass =
  "h-9 rounded-md border border-input bg-field px-2 text-sm text-foreground shadow-xs hover:border-brand-400";

/** Opções de duração: dias fixos, permanente ou um valor livre. */
const DURATIONS = [
  { value: "7", label: "7 dias" },
  { value: "30", label: "30 dias" },
  { value: "90", label: "90 dias" },
  { value: "365", label: "365 dias" },
  { value: "forever", label: "Permanente" },
  { value: "custom", label: "Personalizado" },
] as const;

/** Mensagem em português para um erro de API do painel (o admin não passa pelo i18n). */
export function adminErrorText(err: unknown, notFound = "Não encontrado."): string {
  if (!isApiError(err)) return "Sem conexão com o servidor. Tente novamente.";
  switch (err.status) {
    case 403:
      return "Sem permissão para esta ação.";
    case 404:
      return notFound;
    case 422:
      return "Dados inválidos. Confira os campos e tente de novo.";
    case 429:
      return "Muitas tentativas. Aguarde um instante.";
    default:
      return err.status >= 500
        ? "Erro no servidor. Tente novamente em instantes."
        : err.detail || "Não foi possível concluir a ação.";
  }
}

/** "em 12 dias", "em 3 h", "venceu há 2 dias" ou "Permanente", a partir do instante ISO. */
export function relativeExpiry(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return "Permanente";
  const diff = new Date(iso).getTime() - now.getTime();
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60_000);
  const hours = Math.round(mins / 60);
  const days = Math.round(hours / 24);
  const span =
    mins < 1
      ? "menos de 1 min"
      : mins < 60
        ? `${mins} min`
        : hours < 24
          ? `${hours} h`
          : `${days} ${days === 1 ? "dia" : "dias"}`;
  return diff >= 0 ? `em ${span}` : `venceu há ${span}`;
}

function TierBadge({ tier }: { tier: Tier }) {
  return <Badge variant={tier === "nitro_plus" ? "brand" : "info"}>{TIER_LABEL[tier]}</Badge>;
}

function invalidate(qc: ReturnType<typeof useQueryClient>, prefix: string) {
  return qc.invalidateQueries({
    predicate: (q) => typeof q.queryKey[0] === "string" && q.queryKey[0].startsWith(prefix),
  });
}

/** Seletor de duração (dias fixos, permanente ou personalizado); devolve `undefined` em dias = permanente. */
function useDuration(initial = "30") {
  const [choice, setChoice] = useState<string>(initial);
  const [custom, setCustom] = useState("");
  const customDays = Number.parseInt(custom, 10);
  const customValid = Number.isInteger(customDays) && customDays >= 1 && customDays <= 3650;
  const valid = choice !== "custom" || customValid;
  const days = choice === "forever" ? undefined : choice === "custom" ? customDays : Number(choice);
  return { choice, setChoice, custom, setCustom, valid, days };
}

function DurationField({
  d,
  label = "Duração",
}: {
  d: ReturnType<typeof useDuration>;
  label?: string;
}) {
  const id = useId();
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-dur`}>{label}</Label>
        <select
          id={`${id}-dur`}
          className={selectClass}
          value={d.choice}
          onChange={(e) => d.setChoice(e.target.value)}
        >
          {DURATIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      {d.choice === "custom" ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-cust`}>Dias (1 a 3650)</Label>
          <Input
            id={`${id}-cust`}
            type="number"
            inputMode="numeric"
            min={1}
            max={3650}
            className="w-28"
            value={d.custom}
            aria-invalid={d.custom !== "" && !d.valid}
            onChange={(e) => d.setCustom(e.target.value)}
          />
        </div>
      ) : null}
    </div>
  );
}

function TierField({
  value,
  onChange,
  legend = "Plano",
}: {
  value: Tier;
  onChange: (t: Tier) => void;
  legend?: string;
}) {
  const name = useId();
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1.5 text-sm font-medium">{legend}</legend>
      <div className="flex gap-4">
        {(Object.keys(TIER_LABEL) as Tier[]).map((t) => (
          <label key={t} className="flex min-h-9 items-center gap-2 text-sm">
            <input
              type="radio"
              name={name}
              value={t}
              checked={value === t}
              onChange={() => onChange(t)}
              className="size-4 accent-[var(--primary)]"
            />
            {TIER_LABEL[t]}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/* ----------------------------- Concessões ----------------------------- */

type PickedUser = { id: string; username: string };

function UserPicker({
  picked,
  onPick,
}: {
  picked: PickedUser | null;
  onPick: (u: PickedUser | null) => void;
}) {
  const id = useId();
  const [text, setText] = useState("");
  const q = useDebounced(text.trim());
  const search = useAdminUsers(
    { q, page: 1 },
    { query: { enabled: q.length >= 2 && !picked, staleTime: 10_000 } },
  );
  if (picked) {
    return (
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Usuário</span>
        <div className="flex h-9 items-center gap-2 rounded-md border border-border bg-surface-1 pr-1 pl-3 text-sm">
          <UserRound className="size-4 text-muted-foreground" aria-hidden />
          <span className="min-w-0 truncate">@{picked.username}</span>
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto size-7"
            aria-label="Trocar usuário"
            onClick={() => onPick(null)}
          >
            <X aria-hidden />
          </Button>
        </div>
      </div>
    );
  }
  const items = search.data?.items ?? [];
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>Buscar usuário</Label>
      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          id={id}
          type="search"
          placeholder="Username ou e-mail (mín. 2 letras)"
          className="pl-8"
          value={text}
          maxLength={100}
          autoComplete="off"
          onChange={(e) => setText(e.target.value)}
        />
      </div>
      {q.length >= 2 ? (
        search.isError ? (
          <ErrorNote>{adminErrorText(search.error)}</ErrorNote>
        ) : items.length === 0 ? (
          search.isPending ? (
            <p className="text-xs text-muted-foreground">Buscando…</p>
          ) : (
            <p className="text-xs text-muted-foreground">Nenhum usuário encontrado.</p>
          )
        ) : (
          <ul
            aria-label="Resultados da busca de usuários"
            className="max-h-48 overflow-y-auto rounded-md border border-border bg-card"
          >
            {items.slice(0, 8).map((u) => (
              <li key={u.id}>
                <button
                  type="button"
                  className="flex min-h-10 w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent focus-visible:bg-accent"
                  onClick={() => {
                    onPick({ id: u.id, username: u.username });
                    setText("");
                  }}
                >
                  <span className="font-medium">@{u.username}</span>
                  <span className="min-w-0 truncate text-xs text-muted-foreground">{u.email}</span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}

function GrantForm() {
  const qc = useQueryClient();
  const [user, setUser] = useState<PickedUser | null>(null);
  const [tier, setTier] = useState<Tier>("nitro");
  const d = useDuration();
  const [error, setError] = useState<string | null>(null);
  const grant = useAdminGrantEntitlement({
    mutation: {
      onSuccess: (_, vars) => {
        toast.success(`${TIER_LABEL[vars.data.tier]} concedido a @${user?.username ?? ""}.`);
        setUser(null);
        setError(null);
        void invalidate(qc, "/api/admin/entitlements");
      },
      onError: (err) =>
        setError(
          adminErrorText(err, "Usuário não encontrado (talvez a conta tenha sido removida)."),
        ),
    },
  });
  const ready = user !== null && d.valid && !grant.isPending;
  return (
    <Section title="Conceder plano" hint="Soma à validade vigente do mesmo plano (ou de um maior).">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!user || !d.valid) return;
          setError(null);
          grant.mutate({
            id: user.id,
            data: { tier, ...(d.days !== undefined ? { days: d.days } : {}) },
          });
        }}
      >
        <div className="grid gap-4 md:grid-cols-2">
          <UserPicker picked={user} onPick={setUser} />
          <TierField value={tier} onChange={setTier} />
        </div>
        <DurationField d={d} />
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        <div>
          <Button type="submit" disabled={!ready}>
            {grant.isPending ? "Concedendo…" : "Conceder"}
          </Button>
        </div>
      </form>
    </Section>
  );
}

function RevokeButton({ grant }: { grant: GrantPayload }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const revoke = useAdminRevokeEntitlementGrant({
    mutation: {
      onSuccess: () => {
        toast.success(`Concessão de @${grant.username} revogada.`);
        void invalidate(qc, "/api/admin/entitlements");
      },
      onError: (err) => {
        toast.error(adminErrorText(err, "Esta concessão não existe mais ou já foi revogada."));
        void invalidate(qc, "/api/admin/entitlements");
      },
      onSettled: () => setOpen(false),
    },
  });
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label={`Revogar ${TIER_LABEL[grant.tier]} de @${grant.username}`}
        >
          Revogar
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogTitle>Revogar esta concessão?</AlertDialogTitle>
        <AlertDialogDescription>
          {`@${grant.username} perde o ${TIER_LABEL[grant.tier]} desta concessão agora. Se tiver outra concessão ativa, ela continua valendo.`}
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel>Manter</AlertDialogCancel>
          <AlertDialogAction
            disabled={revoke.isPending}
            onClick={(e) => {
              e.preventDefault();
              revoke.mutate({ id: grant.id });
            }}
          >
            {revoke.isPending ? "Revogando…" : "Revogar"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function grantStatus(g: GrantPayload) {
  if (g.revoked_at) {
    return (
      <div className="flex flex-col">
        <Badge variant="destructive" className="w-fit">
          Revogada
        </Badge>
        <span className="text-xs text-muted-foreground">{formatDateTime(g.revoked_at)}</span>
      </div>
    );
  }
  return (
    <div className="flex flex-col">
      <span className={g.active ? "" : "text-muted-foreground"}>
        {relativeExpiry(g.expires_at)}
      </span>
      <span className="text-xs text-muted-foreground">
        {g.expires_at ? formatDateTime(g.expires_at) : "sem vencimento"}
        {g.active ? "" : " · inativa"}
      </span>
    </div>
  );
}

const GRANT_COLUMNS: Column<GrantPayload>[] = [
  {
    key: "user",
    label: "Usuário",
    render: (g) => (
      <div className="flex flex-col">
        <span>@{g.username}</span>
        {g.display_name ? (
          <span className="text-xs text-muted-foreground">{g.display_name}</span>
        ) : null}
      </div>
    ),
  },
  { key: "tier", label: "Plano", render: (g) => <TierBadge tier={g.tier} /> },
  { key: "source", label: "Origem", render: (g) => SOURCE_LABEL[g.source] ?? g.source },
  { key: "expires", label: "Vencimento", render: grantStatus },
  {
    key: "by",
    label: "Concedido por",
    render: (g) => (g.granted_by ? `@${g.granted_by}` : "—"),
  },
  { key: "created", label: "Criada em", render: (g) => formatDateTime(g.created_at) },
  {
    key: "actions",
    label: "Ações",
    align: "right",
    render: (g) => (g.active ? <RevokeButton grant={g} /> : null),
  },
];

function GrantsList() {
  const [state, setState] = useState<TableState>({ q: "", sort: "", order: "desc", page: 1 });
  const [filter, setFilter] = useState<AdminListEntitlementsState>("active");
  const [tier, setTier] = useState<AdminListEntitlementsTier | "">("");
  const q = useDebounced(state.q.trim());
  const query = useAdminListEntitlements(
    { state: filter, page: state.page, ...(tier ? { tier } : {}), ...(q ? { q } : {}) },
    { query: { placeholderData: keepPreviousData, staleTime: 10_000 } },
  );
  return (
    <section aria-label="Concessões" className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <select
          aria-label="Filtrar por estado"
          className={selectClass}
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value as AdminListEntitlementsState);
            setState((s) => ({ ...s, page: 1 }));
          }}
        >
          <option value="active">Ativas</option>
          <option value="inactive">Inativas</option>
          <option value="all">Todas</option>
        </select>
        <select
          aria-label="Filtrar por plano"
          className={selectClass}
          value={tier}
          onChange={(e) => {
            setTier(e.target.value as AdminListEntitlementsTier | "");
            setState((s) => ({ ...s, page: 1 }));
          }}
        >
          <option value="">Todos os planos</option>
          <option value="nitro">Nitro</option>
          <option value="nitro_plus">Nitro+</option>
        </select>
        <LiveStatus updatedAt={query.dataUpdatedAt} fetching={query.isFetching} live={false} />
      </div>
      <DataTable
        caption="Concessões de plano"
        columns={GRANT_COLUMNS}
        rows={query.data?.items ?? []}
        total={query.data?.total ?? 0}
        pageSize={query.data?.page_size ?? 25}
        state={state}
        onChange={(next) => setState((s) => ({ ...s, ...next }))}
        rowKey={(g) => g.id}
        loading={query.isPending}
        error={query.isError}
        onRetry={() => void query.refetch()}
        searchLabel="Buscar por username ou nome"
        empty="Nenhuma concessão encontrada."
      />
    </section>
  );
}

/* ------------------------------- Códigos ------------------------------ */

function CodesForm({ onCreated }: { onCreated: (codes: NewCodePayload[]) => void }) {
  const qc = useQueryClient();
  const [tier, setTier] = useState<Tier>("nitro");
  const d = useDuration();
  const [quantity, setQuantity] = useState("1");
  const [expiry, setExpiry] = useState("");
  const [error, setError] = useState<string | null>(null);
  const qty = Number.parseInt(quantity, 10);
  const qtyValid = Number.isInteger(qty) && qty >= 1 && qty <= 100;
  const exp = Number.parseInt(expiry, 10);
  const expValid = expiry === "" || (Number.isInteger(exp) && exp >= 1 && exp <= 365);
  const create = useAdminCreateRedeemCodes({
    mutation: {
      onSuccess: (res) => {
        setError(null);
        onCreated(res.items ?? []);
        void invalidate(qc, "/api/admin/redeem-codes");
      },
      onError: (err) => setError(adminErrorText(err)),
    },
  });
  return (
    <Section
      title="Gerar códigos"
      hint="O texto dos códigos aparece uma única vez, logo após gerar."
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!qtyValid || !d.valid || !expValid) return;
          setError(null);
          create.mutate({
            data: {
              tier,
              quantity: qty,
              ...(d.days !== undefined ? { days: d.days } : {}),
              ...(expiry !== "" ? { expires_in_days: exp } : {}),
            },
          });
        }}
      >
        <div className="flex flex-wrap items-end gap-x-6 gap-y-4">
          <TierField value={tier} onChange={setTier} legend="Plano do código" />
          <DurationField d={d} label="Dias de plano" />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="codes-qty">Quantidade (1 a 100)</Label>
            <Input
              id="codes-qty"
              type="number"
              inputMode="numeric"
              min={1}
              max={100}
              className="w-28"
              value={quantity}
              aria-invalid={!qtyValid}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="codes-exp">Validade do código, em dias (opcional)</Label>
            <Input
              id="codes-exp"
              type="number"
              inputMode="numeric"
              min={1}
              max={365}
              placeholder="Não vence"
              className="w-36"
              value={expiry}
              aria-invalid={!expValid}
              onChange={(e) => setExpiry(e.target.value)}
            />
          </div>
        </div>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        <div>
          <Button type="submit" disabled={!qtyValid || !d.valid || !expValid || create.isPending}>
            <KeyRound aria-hidden /> {create.isPending ? "Gerando…" : "Gerar códigos"}
          </Button>
        </div>
      </form>
    </Section>
  );
}

/** Os códigos recém-gerados: única exibição do texto (o servidor guarda só o hash). */
function NewCodesBox({ codes, onDismiss }: { codes: NewCodePayload[]; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  const text = codes.map((c) => c.code).join("\n");
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast.success(
        `${codes.length} ${codes.length === 1 ? "código copiado" : "códigos copiados"}.`,
      );
    } catch {
      toast.error("Não foi possível copiar. Selecione o texto e copie à mão.");
    }
  }
  return (
    <section
      aria-label="Códigos gerados"
      className="flex flex-col gap-3 rounded-xl border border-warning-text/40 bg-warning-soft p-4"
    >
      <h2 className="text-base font-semibold">
        {codes.length} {codes.length === 1 ? "código gerado" : "códigos gerados"}
      </h2>
      <p role="alert" className="text-sm">
        Copie agora: estes códigos não serão mostrados de novo. Depois de fechar, só o final de cada
        um fica na lista.
      </p>
      <Label htmlFor="new-codes" className="sr-only">
        Códigos gerados, um por linha
      </Label>
      <textarea
        id="new-codes"
        readOnly
        rows={Math.min(Math.max(codes.length, 2), 10)}
        value={text}
        onFocus={(e) => e.currentTarget.select()}
        className="w-full rounded-md border border-input bg-field p-2 font-mono text-sm"
      />
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void copy()}>
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />} Copiar todos
        </Button>
        <Button variant="outline" onClick={onDismiss}>
          Já copiei, fechar
        </Button>
      </div>
    </section>
  );
}

const CODE_COLUMNS: Column<CodePayload>[] = [
  {
    key: "hint",
    label: "Código",
    render: (c) => <span className="font-mono">{`SPOOK-····-${c.hint}`}</span>,
  },
  { key: "tier", label: "Plano", render: (c) => <TierBadge tier={c.tier} /> },
  { key: "days", label: "Duração", render: (c) => (c.days ? `${c.days} dias` : "Permanente") },
  {
    key: "state",
    label: "Estado",
    render: (c) => <Badge variant={CODE_STATE_VARIANT[c.state]}>{CODE_STATE_LABEL[c.state]}</Badge>,
  },
  { key: "created", label: "Gerado em", render: (c) => formatDateTime(c.created_at) },
  { key: "by", label: "Gerado por", render: (c) => (c.created_by ? `@${c.created_by}` : "—") },
  {
    key: "redeemed",
    label: "Resgatado",
    render: (c) =>
      c.redeemed_at
        ? `${c.redeemed_by ? `@${c.redeemed_by} · ` : ""}${formatDateTime(c.redeemed_at)}`
        : "—",
  },
  {
    key: "expires",
    label: "Vence em",
    render: (c) => (c.expires_at ? formatDateTime(c.expires_at) : "Não vence"),
  },
];

function CodesList() {
  const [state, setState] = useState<TableState>({ q: "", sort: "", order: "desc", page: 1 });
  const [filter, setFilter] = useState<AdminListRedeemCodesState>("unused");
  const [tier, setTier] = useState<AdminListRedeemCodesTier | "">("");
  const query = useAdminListRedeemCodes(
    { state: filter, page: state.page, ...(tier ? { tier } : {}) },
    { query: { placeholderData: keepPreviousData, staleTime: 10_000 } },
  );
  const pageSize = query.data?.page_size ?? 25;
  return (
    <section aria-label="Códigos" className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <select
          aria-label="Filtrar códigos por estado"
          className={selectClass}
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value as AdminListRedeemCodesState);
            setState((s) => ({ ...s, page: 1 }));
          }}
        >
          <option value="unused">Não usados</option>
          <option value="used">Usados</option>
          <option value="expired">Vencidos</option>
          <option value="all">Todos</option>
        </select>
        <select
          aria-label="Filtrar códigos por plano"
          className={selectClass}
          value={tier}
          onChange={(e) => {
            setTier(e.target.value as AdminListRedeemCodesTier | "");
            setState((s) => ({ ...s, page: 1 }));
          }}
        >
          <option value="">Todos os planos</option>
          <option value="nitro">Nitro</option>
          <option value="nitro_plus">Nitro+</option>
        </select>
      </div>
      <DataTable
        caption="Códigos de resgate"
        columns={CODE_COLUMNS}
        rows={query.data?.items ?? []}
        total={query.data?.total ?? 0}
        pageSize={pageSize}
        state={state}
        onChange={(next) => setState((s) => ({ ...s, ...next }))}
        rowKey={(c) => c.id}
        loading={query.isPending}
        error={query.isError}
        onRetry={() => void query.refetch()}
        searchLabel="Sem busca por texto (o servidor guarda só o hash)"
        empty="Nenhum código encontrado."
        hideSearch
      />
    </section>
  );
}

/* -------------------------------- Página ------------------------------ */

export function AdminNitroPage() {
  const [fresh, setFresh] = useState<NewCodePayload[] | null>(null);
  return (
    <>
      <PageHeader
        title="Nitro"
        subtitle="Conceda Nitro e Nitro+, revogue e gere códigos de resgate."
      />
      <Tabs defaultValue="grants" className="flex flex-col gap-4">
        <TabsList variant="underline" aria-label="Seções do Nitro">
          <TabsTrigger variant="underline" value="grants">
            Concessões
          </TabsTrigger>
          <TabsTrigger variant="underline" value="codes">
            Códigos
          </TabsTrigger>
        </TabsList>
        <TabsContent value="grants" className="flex flex-col gap-4">
          <GrantForm />
          <GrantsList />
        </TabsContent>
        <TabsContent value="codes" className="flex flex-col gap-4">
          <CodesForm onCreated={setFresh} />
          {fresh && fresh.length > 0 ? (
            <NewCodesBox codes={fresh} onDismiss={() => setFresh(null)} />
          ) : null}
          <CodesList />
        </TabsContent>
      </Tabs>
    </>
  );
}
