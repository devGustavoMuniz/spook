import {
  type ChannelPayload,
  isApiError,
  type MemberPayload,
  type RolePayload,
  useListChannelOverwrites,
  useSetChannelOverwrite,
} from "@spook/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Lock, ShieldCheck, Slash, UserRound, X } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogActions, DialogContent, DialogHead } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { memberName, useGuildMembers } from "@/features/members/use-members";
import { type MessageKey, useT } from "@/i18n";
import { appMessage } from "@/lib/app-errors";
import { colorToHex } from "@/lib/colors";
import { type Guild, myTopPosition, rolesOf, topPosition } from "@/lib/guild";
import {
  allowedViewers,
  changes,
  isPrivate,
  keyOf,
  type Overwrite,
  permissionsForChannel,
  setPrivate,
  type TargetType,
  type Tri,
  toDraft,
  triOf,
  withTri,
} from "@/lib/overwrites";
import { cn } from "@/lib/utils";

const ADD_PLACEHOLDER = "__add__";

/**
 * Editor de permissões de um canal (overwrites): "Canal privado" (o @everyone não vê; só quem for liberado
 * entra) e, por cargo ou pessoa, cada permissão em três estados (Negar, Herdar, Permitir). O servidor valida
 * tudo (hierarquia, só conceder o que se tem); aqui as linhas acima do seu cargo ficam travadas.
 */
export function ChannelPermissionsDialog({
  guild,
  channel,
  onClose,
}: {
  guild: Guild;
  channel: ChannelPayload | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={!!channel} onOpenChange={(o) => !o && onClose()}>
      {channel ? <Editor guild={guild} channel={channel} /> : null}
    </Dialog>
  );
}

function Editor({ guild, channel }: { guild: Guild; channel: ChannelPayload }) {
  const { t, locale } = useT();
  const qc = useQueryClient();
  const list = useListChannelOverwrites(channel.id);
  const set = useSetChannelOverwrite();
  const members = useGuildMembers(guild.id);
  const roles = rolesOf(guild);
  const original = useMemo<Overwrite[]>(
    () =>
      (list.data ?? []).map((o) => ({
        type: o.type as TargetType,
        id: o.target_id,
        allow: o.allow,
        deny: o.deny,
      })),
    [list.data],
  );
  const [draft, setDraft] = useState<Map<string, Overwrite> | null>(null);
  const [selected, setSelected] = useState(keyOf({ type: "role", id: guild.id }));
  const [saving, setSaving] = useState(false);
  const everyoneKey = keyOf({ type: "role", id: guild.id });

  // O rascunho nasce quando a lista chega (e volta ao servidor depois de salvar).
  useEffect(() => {
    if (list.data) setDraft(toDraft(original));
  }, [list.data, original]);

  const roleById = useMemo(() => new Map(roles.map((r) => [r.id, r])), [roles]);
  const memberById = useMemo(
    () => new Map((members.data?.members ?? []).map((m) => [m.user_id, m])),
    [members.data],
  );

  if (list.isPending || !draft) {
    return (
      <DialogContent flush size="xl" className="h-[min(40rem,92svh)]">
        <DialogHead
          icon={ShieldCheck}
          title={t("channels.perms.title", { name: channel.name })}
          description={t("channels.perms.desc")}
        />
        {list.isError ? (
          <div role="alert" className="flex items-center gap-3 p-6 text-sm">
            <span className="text-destructive-text">{appMessage(list.error)}</span>
            <Button size="sm" variant="outline" onClick={() => void list.refetch()}>
              {t("channels.perms.retry")}
            </Button>
          </div>
        ) : (
          <output className="flex flex-col gap-3 p-6">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-40 w-full" />
            <span className="sr-only">{t("channels.perms.loading")}</span>
          </output>
        )}
      </DialogContent>
    );
  }

  const pending = changes(original, draft);
  const dirty = pending.length > 0;
  const priv = isPrivate(draft, guild.id);
  const viewers = allowedViewers(draft, guild.id);
  const myTop = myTopPosition(guild);

  /** Quem tem rank igual ou acima do meu não é editável (o @everyone não tem hierarquia). */
  const locked = (o: Pick<Overwrite, "type" | "id">): boolean => {
    if (guild.is_owner) return false;
    if (o.type === "role") {
      if (o.id === guild.id) return false;
      return (roleById.get(o.id)?.position ?? 0) >= myTop;
    }
    const m = memberById.get(o.id);
    return !m || o.id === guild.owner_id || topPosition(guild, m.role_ids ?? []) >= myTop;
  };
  const nameOf = (o: Pick<Overwrite, "type" | "id">): string => {
    if (o.type === "role")
      return o.id === guild.id
        ? "@everyone"
        : (roleById.get(o.id)?.name ?? t("channels.perms.fallbackRole"));
    const m = memberById.get(o.id);
    return m ? memberName(m) : t("channels.perms.fallbackMember");
  };

  function update(o: Overwrite) {
    setDraft((d) => new Map(d ?? []).set(keyOf(o), o));
  }
  function ensure(o: Pick<Overwrite, "type" | "id">): Overwrite {
    return draft?.get(keyOf(o)) ?? { type: o.type, id: o.id, allow: 0, deny: 0 };
  }
  function addTarget(type: TargetType, id: string) {
    const o = ensure({ type, id });
    update(o);
    setSelected(keyOf(o));
  }
  function removeTarget(key: string) {
    setDraft((d) => {
      const next = new Map(d ?? []);
      next.delete(key);
      return next;
    });
    if (selected === key) setSelected(everyoneKey);
  }
  function toggleViewer(o: Pick<Overwrite, "type" | "id">, on: boolean) {
    update(withTri(ensure(o), "VIEW_CHANNEL", on ? "allow" : "inherit"));
  }

  async function save() {
    setSaving(true);
    try {
      for (const o of pending) {
        await set.mutateAsync({
          channelId: channel.id,
          type: o.type,
          targetId: o.id,
          data: { allow: o.allow, deny: o.deny },
        });
      }
      toast.success(t("channels.perms.saved"));
      await qc.invalidateQueries({ queryKey: list.queryKey });
    } catch (e) {
      toast.error(
        isApiError(e) && e.status === 403 ? t("channels.perms.forbidden") : appMessage(e),
      );
      await qc.invalidateQueries({ queryKey: list.queryKey });
    } finally {
      setSaving(false);
    }
  }

  const current = ensure(parseKey(selected));
  const entries = [...draft.values()].sort(
    (a, b) => rank(a, guild.id) - rank(b, guild.id) || nameOf(a).localeCompare(nameOf(b), locale),
  );
  const present = new Set(draft.keys());
  const addableRoles = roles.filter(
    (r) => !r.is_everyone && !present.has(keyOf({ type: "role", id: r.id })),
  );
  const addableMembers = (members.data?.members ?? []).filter(
    (m) => m.user_id !== guild.owner_id && !present.has(keyOf({ type: "member", id: m.user_id })),
  );

  return (
    <DialogContent flush size="xl" className="h-[min(44rem,92svh)]">
      <DialogHead
        icon={ShieldCheck}
        title={t("channels.perms.title", { name: channel.name })}
        description={t("channels.perms.fullDesc")}
      />
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <div className="flex min-h-0 flex-col border-b md:w-72 md:shrink-0 md:border-r md:border-b-0">
          <PrivateSection
            priv={priv}
            onPrivate={(on) => setDraft((d) => setPrivate(d ?? new Map(), guild.id, on))}
            viewers={viewers}
            nameOf={nameOf}
            lockedOf={locked}
            onToggle={toggleViewer}
            addableRoles={addableRoles}
            addableMembers={addableMembers}
            onAddRole={(id) => toggleViewer({ type: "role", id }, true)}
            onAddMember={(id) => toggleViewer({ type: "member", id }, true)}
          />
          <h3 className="px-4 pt-3 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            {t("channels.perms.advanced")}
          </h3>
          <ScrollArea className="min-h-0 flex-1">
            <ul
              aria-label={t("channels.perms.listAria")}
              className="flex flex-col gap-0.5 px-2 pb-2"
            >
              {entries.map((o) => {
                const k = keyOf(o);
                const active = k === selected;
                const role = o.type === "role" ? roleById.get(o.id) : undefined;
                return (
                  <li key={k} className="group/row flex items-center">
                    <button
                      type="button"
                      onClick={() => setSelected(k)}
                      aria-current={active}
                      className={cn(
                        "flex min-h-10 min-w-0 flex-1 items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-accent",
                        active &&
                          "bg-brand-500/15 font-medium shadow-[inset_2px_0_0_var(--primary)]",
                      )}
                    >
                      {o.type === "role" ? (
                        <span
                          aria-hidden
                          className="size-3.5 shrink-0 rounded-full border border-border"
                          style={{ background: colorToHex(role?.color ?? null) ?? "transparent" }}
                        />
                      ) : (
                        <UserRound
                          aria-hidden
                          className="size-3.5 shrink-0 text-muted-foreground"
                        />
                      )}
                      <span className="min-w-0 flex-1 truncate">{nameOf(o)}</span>
                      {locked(o) ? (
                        <>
                          <Lock className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                          <span className="sr-only">{t("channels.perms.readOnlySr")}</span>
                        </>
                      ) : null}
                    </button>
                    {k !== everyoneKey && !locked(o) ? (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="size-8 shrink-0"
                        aria-label={t("channels.perms.removeRules", { name: nameOf(o) })}
                        onClick={() => removeTarget(k)}
                      >
                        <X />
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </ScrollArea>
          <div className="flex flex-col gap-2 border-t p-3">
            <AddTarget
              roles={addableRoles}
              members={addableMembers}
              onRole={(id) => addTarget("role", id)}
              onMember={(id) => addTarget("member", id)}
            />
          </div>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-1 p-4">
            <h3 className="text-sm font-semibold">{nameOf(current)}</h3>
            {locked(current) ? (
              <p className="text-xs text-muted-foreground">{t("channels.perms.lockedNote")}</p>
            ) : null}
            <ul
              aria-label={t("channels.perms.title", { name: nameOf(current) })}
              className="mt-2 flex flex-col"
            >
              {permissionsForChannel(channel.type).map((p) => (
                <PermissionRow
                  key={p.name}
                  label={t(p.labelKey)}
                  description={t(p.descKey)}
                  value={triOf(current, p.name)}
                  disabled={locked(current)}
                  onChange={(v) => update(withTri(current, p.name, v))}
                />
              ))}
            </ul>
          </div>
        </ScrollArea>
      </div>
      <DialogActions>
        <Button
          variant="ghost"
          disabled={!dirty || saving}
          onClick={() => setDraft(toDraft(original))}
        >
          {t("channels.perms.discard")}
        </Button>
        <Button onClick={() => void save()} loading={saving} disabled={!dirty}>
          {t("channels.perms.save")}
        </Button>
      </DialogActions>
      <span className="sr-only" aria-live="polite">
        {dirty ? t("channels.perms.unsavedSr") : ""}
      </span>
    </DialogContent>
  );
}

const parseKey = (k: string): { type: TargetType; id: string } => {
  const [type, id] = k.split(":");
  return { type: type as TargetType, id: id ?? "" };
};

/** @everyone primeiro, depois cargos, depois pessoas. */
const rank = (o: Overwrite, guildId: string) =>
  o.type === "role" && o.id === guildId ? 0 : o.type === "role" ? 1 : 2;

function PrivateSection({
  priv,
  onPrivate,
  viewers,
  nameOf,
  lockedOf,
  onToggle,
  addableRoles,
  addableMembers,
  onAddRole,
  onAddMember,
}: {
  priv: boolean;
  onPrivate: (on: boolean) => void;
  viewers: Overwrite[];
  nameOf: (o: Pick<Overwrite, "type" | "id">) => string;
  lockedOf: (o: Pick<Overwrite, "type" | "id">) => boolean;
  onToggle: (o: Pick<Overwrite, "type" | "id">, on: boolean) => void;
  addableRoles: RolePayload[];
  addableMembers: MemberPayload[];
  onAddRole: (id: string) => void;
  onAddMember: (id: string) => void;
}) {
  const { t } = useT();
  const id = useId();
  return (
    <section aria-label={t("channels.perms.private")} className="flex flex-col gap-2 border-b p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <label htmlFor={`${id}-priv`} className="text-sm font-medium">
            {t("channels.perms.private")}
          </label>
          <p id={`${id}-desc`} className="text-xs text-pretty text-muted-foreground">
            {t("channels.perms.privateDesc")}
          </p>
        </div>
        <Switch
          id={`${id}-priv`}
          aria-describedby={`${id}-desc`}
          checked={priv}
          onCheckedChange={onPrivate}
        />
      </div>
      {priv ? (
        <>
          <ul aria-label={t("channels.perms.whoCanJoin")} className="flex flex-wrap gap-1.5">
            {viewers.length === 0 ? (
              <li className="text-xs text-muted-foreground">{t("channels.perms.nobody")}</li>
            ) : null}
            {viewers.map((o) => (
              <li
                key={keyOf(o)}
                className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-surface-1 py-0.5 pr-1 pl-2.5 text-xs"
              >
                <span className="truncate">{nameOf(o)}</span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="size-5 rounded-full"
                  disabled={lockedOf(o)}
                  aria-label={t("channels.perms.removeViewer", { name: nameOf(o) })}
                  onClick={() => onToggle(o, false)}
                >
                  <X className="size-3" />
                </Button>
              </li>
            ))}
          </ul>
          <div className="grid grid-cols-2 gap-2">
            <PickOne
              label={t("channels.perms.allowRole")}
              options={addableRoles.map((r) => ({ value: r.id, label: r.name }))}
              onPick={onAddRole}
            />
            <PickOne
              label={t("channels.perms.allowPerson")}
              options={addableMembers.map((m) => ({ value: m.user_id, label: memberName(m) }))}
              onPick={onAddMember}
            />
          </div>
        </>
      ) : null}
    </section>
  );
}

function PickOne({
  label,
  options,
  onPick,
}: {
  label: string;
  options: { value: string; label: string }[];
  onPick: (value: string) => void;
}) {
  return (
    <Select value={ADD_PLACEHOLDER} onValueChange={(v) => v !== ADD_PLACEHOLDER && onPick(v)}>
      <SelectTrigger aria-label={label} disabled={options.length === 0}>
        <SelectValue placeholder={label}>{label}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ADD_PLACEHOLDER} className="hidden">
          {label}
        </SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function AddTarget({
  roles,
  members,
  onRole,
  onMember,
}: {
  roles: RolePayload[];
  members: MemberPayload[];
  onRole: (id: string) => void;
  onMember: (id: string) => void;
}) {
  const { t } = useT();
  return (
    <div className="grid grid-cols-2 gap-2">
      <PickOne
        label={t("channels.perms.addRole")}
        options={roles.map((r) => ({ value: r.id, label: r.name }))}
        onPick={onRole}
      />
      <PickOne
        label={t("channels.perms.addPerson")}
        options={members.map((m) => ({ value: m.user_id, label: memberName(m) }))}
        onPick={onMember}
      />
    </div>
  );
}

const TRI: { value: Tri; labelKey: MessageKey; icon: typeof Check }[] = [
  { value: "deny", labelKey: "channels.perms.tri.deny", icon: X },
  { value: "inherit", labelKey: "channels.perms.tri.inherit", icon: Slash },
  { value: "allow", labelKey: "channels.perms.tri.allow", icon: Check },
];

function PermissionRow({
  label,
  description,
  value,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  value: Tri;
  disabled?: boolean;
  onChange: (v: Tri) => void;
}) {
  const { t } = useT();
  const id = useId();
  function onKey(e: React.KeyboardEvent) {
    const i = TRI.findIndex((x) => x.value === value);
    const next =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? i + 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? i - 1
          : null;
    if (next === null) return;
    e.preventDefault();
    const target = TRI[(next + TRI.length) % TRI.length];
    if (target) onChange(target.value);
  }
  return (
    <li className="flex flex-col gap-2 border-b py-3 last:border-b-0 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <p id={`${id}-l`} className="text-sm font-medium">
          {label}
        </p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <div
        role="radiogroup"
        aria-labelledby={`${id}-l`}
        onKeyDown={onKey}
        className="inline-flex shrink-0 overflow-hidden rounded-md border border-border"
      >
        {TRI.map((tri) => {
          const on = value === tri.value;
          const Icon = tri.icon;
          return (
            // biome-ignore lint/a11y/useSemanticElements: botão de rádio personalizado
            <button
              key={tri.value}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              disabled={disabled}
              onClick={() => onChange(tri.value)}
              className={cn(
                "inline-flex min-h-9 min-w-24 cursor-pointer items-center justify-center gap-1.5 px-3 text-xs font-medium transition-colors focus-visible:z-10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60",
                !on && "bg-field text-muted-foreground hover:bg-accent",
                on && tri.value === "allow" && "bg-success text-success-foreground",
                on && tri.value === "deny" && "bg-destructive text-destructive-foreground",
                on && tri.value === "inherit" && "bg-surface-3 text-foreground",
              )}
            >
              <Icon className="size-3.5" aria-hidden />
              {t(tri.labelKey)}
            </button>
          );
        })}
      </div>
    </li>
  );
}
