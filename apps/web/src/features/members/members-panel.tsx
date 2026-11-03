import { type MemberPayload, useGetMe } from "@spook/shared";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Copy,
  Crown,
  Gavel,
  MoreHorizontal,
  Pencil,
  ShieldCheck,
  UserMinus,
  UserRound,
} from "lucide-react";
import { useMemo, useRef } from "react";
import { toast } from "sonner";
import { statusLabel } from "@/components/presence-dot";
import { SideSheet } from "@/components/shell";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { useStartDm } from "@/features/dms/use-start-dm";
import { CustomStatusText } from "@/features/presence/custom-status-text";
import { displayStatus, usePresenceStore } from "@/features/presence/store";
import { appMessage } from "@/lib/app-errors";
import { colorToHex } from "@/lib/colors";
import {
  canBan,
  canKick,
  canManageRole,
  canNickname,
  type Guild,
  memberColor,
  rolesOf,
} from "@/lib/guild";
import { useReadableRoleColor } from "@/lib/role-color";
import { groupMembers, type MemberGroup } from "./groups";
import { useMemberUi } from "./member-ui";
import { memberName, useGuildMembers } from "./use-members";

/** Acima disto a lista é virtualizada (só as linhas visíveis ficam no DOM). */
const VIRTUALIZE_FROM = 150;

type Flat =
  | { kind: "header"; key: string; group: MemberGroup }
  | { kind: "member"; key: string; member: MemberPayload; offline: boolean };

export function MembersPanel({ guild }: { guild: Guild }) {
  const { data: me } = useGetMe();
  const members = useGuildMembers(guild.id);
  const list = members.data?.members ?? [];
  const statuses = usePresenceStore((s) => s.statuses);
  const meId = usePresenceStore((s) => s.meId);
  const mine = usePresenceStore((s) => s.mine);

  // `statuses` e `mine` mudam quando a presença muda: o agrupamento acompanha em tempo real.
  const groups = useMemo(
    () => groupMembers(guild, list, (id) => displayStatus({ statuses, meId, mine }, id)),
    [guild, list, statuses, meId, mine],
  );
  const flat = useMemo<Flat[]>(
    () =>
      groups.flatMap((g) => [
        { kind: "header" as const, key: `h:${g.key}`, group: g },
        ...g.members.map((m) => ({
          kind: "member" as const,
          key: `m:${m.user_id}`,
          member: m,
          offline: g.offline,
        })),
      ]),
    [groups],
  );

  return (
    <SideSheet label="Membros" className="w-60 shrink-0 flex-col border-l bg-sidebar">
      <h2 className="px-4 pt-4 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Membros{members.data ? ` — ${list.length}` : ""}
      </h2>
      {members.isPending ? (
        <output className="flex flex-col gap-2 px-3 pt-3" aria-label="Carregando membros">
          <span className="sr-only">Carregando…</span>
          {["a", "b", "c", "d", "e", "f", "g", "h"].map((k) => (
            <span key={k} className="flex items-center gap-3">
              <Skeleton className="size-8 rounded-full" />
              <Skeleton className="h-3.5 flex-1" />
            </span>
          ))}
        </output>
      ) : members.isError ? (
        <p className="px-4 pt-3 text-sm text-destructive-text">{appMessage(members.error)}</p>
      ) : flat.length > VIRTUALIZE_FROM ? (
        <VirtualList guild={guild} flat={flat} meId={me?.id} />
      ) : (
        <ul aria-label="Membros" className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          {flat.map((row) => (
            <FlatRow key={row.key} row={row} guild={guild} meId={me?.id} />
          ))}
        </ul>
      )}
      {members.data?.has_more ? (
        <p className="px-4 pb-3 text-xs text-muted-foreground">Mostrando os primeiros membros.</p>
      ) : null}
    </SideSheet>
  );
}

function VirtualList({ guild, flat, meId }: { guild: Guild; flat: Flat[]; meId?: string }) {
  "use no memo";
  const ref = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({
    count: flat.length,
    getScrollElement: () => ref.current,
    estimateSize: (i) => (flat[i]?.kind === "header" ? 36 : 48),
    getItemKey: (i) => flat[i]?.key ?? i,
    overscan: 12,
  });
  return (
    <div ref={ref} className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
      <ul
        aria-label="Membros"
        style={{ height: v.getTotalSize(), position: "relative", width: "100%" }}
      >
        {v.getVirtualItems().map((item) => {
          const row = flat[item.index];
          if (!row) return null;
          return (
            <FlatRow
              key={item.key}
              row={row}
              guild={guild}
              meId={meId}
              virtual={{ index: item.index, ref: v.measureElement, start: item.start }}
            />
          );
        })}
      </ul>
    </div>
  );
}

type Virtual = { index: number; ref: (el: HTMLElement | null) => void; start: number };

/** Linha da lista; na lista virtualizada vem posicionada em absoluto (só `transform`). */
function liProps(virtual?: Virtual) {
  return virtual
    ? {
        "data-index": virtual.index,
        ref: virtual.ref,
        style: {
          position: "absolute" as const,
          top: 0,
          left: 0,
          width: "100%",
          transform: `translateY(${virtual.start}px)`,
        },
      }
    : {};
}

function FlatRow({
  row,
  guild,
  meId,
  virtual,
}: {
  row: Flat;
  guild: Guild;
  meId?: string;
  virtual?: Virtual;
}) {
  if (row.kind === "header")
    return <GroupHeader group={row.group} guild={guild} virtual={virtual} />;
  return (
    <MemberItem
      guild={guild}
      member={row.member}
      offline={row.offline}
      meId={meId}
      virtual={virtual}
    />
  );
}

function GroupHeader({
  group,
  guild,
  virtual,
}: {
  group: MemberGroup;
  guild: Guild;
  virtual?: Virtual;
}) {
  const role = group.roleId ? rolesOf(guild).find((r) => r.id === group.roleId) : undefined;
  const color = role ? colorToHex(role.color) : undefined;
  return (
    <li className="list-none px-2 pt-4 pb-1" {...liProps(virtual)}>
      <h3 className="flex items-center gap-1.5 truncate text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {color ? (
          <span
            aria-hidden
            className="size-2 shrink-0 rounded-full"
            style={{ background: color }}
          />
        ) : null}
        <span className="truncate">{group.title}</span>
        <span className="tabular shrink-0 font-normal">— {group.members.length}</span>
      </h3>
    </li>
  );
}

function MemberItem({
  guild,
  member: m,
  offline,
  meId,
  virtual,
}: {
  guild: Guild;
  member: MemberPayload;
  offline: boolean;
  meId?: string;
  virtual?: Virtual;
}) {
  const ui = useMemberUi();
  const { startDm } = useStartDm();
  const name = memberName(m);
  const raw = memberColor(guild, m);
  const readable = useReadableRoleColor(raw);
  const status = usePresenceStore((s) => displayStatus(s, m.user_id));
  const mayKick = !!meId && canKick(guild, m, meId);
  const mayBan = !!meId && canBan(guild, m, meId);
  const mayNick = !!meId && canNickname(guild, m, meId);
  const mayRoles =
    rolesOf(guild).some((r) => !r.is_everyone && canManageRole(guild, r)) &&
    m.user_id !== guild.owner_id;

  async function copyId() {
    try {
      await navigator.clipboard.writeText(m.user_id);
      toast.success("ID de usuário copiado.");
    } catch {
      toast.error("Não foi possível copiar.");
    }
  }

  return (
    <li className="group/member relative list-none" {...liProps(virtual)}>
      <button
        type="button"
        onClick={(e) =>
          ui?.openProfile(
            {
              id: m.user_id,
              username: m.username,
              displayName: m.nickname || m.display_name || undefined,
              avatarUrl: m.avatar_url,
            },
            e.currentTarget,
          )
        }
        aria-label={`Ver perfil de ${name}`}
        className="flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-accent focus-visible:bg-accent aria-expanded:bg-accent"
      >
        <span className={offline ? "opacity-55" : undefined}>
          <Avatar
            url={m.avatar_url}
            name={name}
            seed={m.user_id}
            size={32}
            status={status}
            statusLabel={statusLabel[status]}
          />
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={`flex items-center gap-1 text-sm font-medium ${offline && !readable ? "text-muted-foreground" : ""}`}
            style={readable ? { color: readable } : undefined}
          >
            <span className={`truncate ${offline ? "opacity-80" : ""}`}>{name}</span>
            {m.user_id === guild.owner_id ? (
              <Crown
                className="size-3.5 shrink-0 text-warning-text"
                role="img"
                aria-label="Dono do servidor"
              />
            ) : null}
          </span>
          <CustomStatusText
            userId={m.user_id}
            className="block truncate text-xs text-muted-foreground"
          />
        </span>
      </button>
      {m.user_id !== meId ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="absolute top-1/2 right-1 size-7 -translate-y-1/2 opacity-0 group-focus-within/member:opacity-100 group-hover/member:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100"
              aria-label={`Opções de ${name}`}
            >
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => void startDm(m.user_id)}>
              <UserRound /> Enviar mensagem
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void copyId()}>
              <Copy /> Copiar ID de usuário
            </DropdownMenuItem>
            {mayRoles ? (
              <DropdownMenuItem onSelect={() => ui?.openRoles(m)}>
                <ShieldCheck /> Gerenciar cargos
              </DropdownMenuItem>
            ) : null}
            {mayNick ? (
              <DropdownMenuItem onSelect={() => ui?.openNick(m, false)}>
                <Pencil /> Mudar apelido
              </DropdownMenuItem>
            ) : null}
            {mayKick ? (
              <DropdownMenuItem destructive onSelect={() => ui?.openKick(m)}>
                <UserMinus /> Expulsar
              </DropdownMenuItem>
            ) : null}
            {mayBan ? (
              <DropdownMenuItem destructive onSelect={() => ui?.openBan(m)}>
                <Gavel /> Banir
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </li>
  );
}
