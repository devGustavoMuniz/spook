import {
  hasPermission,
  type RolePayload,
  useCreateGuildRole,
  useDeleteGuildRole,
  useUpdateGuildRole,
} from "@spook/shared";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Lock, Plus, ShieldAlert, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { appMessage } from "@/lib/app-errors";
import { colorToHex, hexToColor } from "@/lib/colors";
import { canManageRole, type Guild, myTopPosition, rolesOf } from "@/lib/guild";
import { refreshGuilds } from "@/lib/guild-cache";
import { cn } from "@/lib/utils";
import { useReportDirty } from "./dirty";
import { flagOf, PERMISSION_GROUPS } from "./permission-labels";

/** Amostras de cor de cargo (o servidor guarda qualquer RGB; estas são só atalhos com nome). */
const SWATCHES = [
  { hex: "#7c5cc4", name: "Roxo" },
  { hex: "#3b82f6", name: "Azul" },
  { hex: "#14b8a6", name: "Turquesa" },
  { hex: "#22c55e", name: "Verde" },
  { hex: "#eab308", name: "Amarelo" },
  { hex: "#f97316", name: "Laranja" },
  { hex: "#ef4444", name: "Vermelho" },
  { hex: "#ec4899", name: "Rosa" },
  { hex: "#99aab5", name: "Cinza" },
];

const colorName = (hex: string | null) =>
  hex === null
    ? "Sem cor"
    : (SWATCHES.find((s) => s.hex === hex.toLowerCase())?.name ?? "Personalizada");

/** Cargos: lista + detalhe lado a lado no desktop; lista → detalhe (com "voltar") no celular. */
export function RolesTab({ guild }: { guild: Guild }) {
  const qc = useQueryClient();
  const create = useCreateGuildRole();
  const roles = rolesOf(guild);
  const [selectedId, setSelectedId] = useState<string | undefined>(roles[0]?.id);
  const [detail, setDetail] = useState(false); // < 768 px: mostrando o detalhe
  const [editorDirty, setEditorDirty] = useState(false);
  const [switchTo, setSwitchTo] = useState<string | null>(null);
  const selected = roles.find((r) => r.id === selectedId) ?? roles[0];

  async function createRole() {
    try {
      const role = await create.mutateAsync({ guildId: guild.id, data: { name: "Novo cargo" } });
      await refreshGuilds(qc);
      setSelectedId(role.id);
      setDetail(true);
    } catch (e) {
      toast.error(appMessage(e));
    }
  }

  function pick(id: string) {
    if (id !== selected?.id && editorDirty) setSwitchTo(id);
    else {
      setSelectedId(id);
      setDetail(true);
    }
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div
        className={cn(
          "min-h-0 w-full shrink-0 flex-col border-border md:flex md:w-64 md:border-r",
          detail ? "hidden" : "flex",
        )}
      >
        <div className="flex flex-col gap-2 px-4 pt-4 pb-2">
          <Button
            variant="soft"
            size="sm"
            onClick={() => void createRole()}
            loading={create.isPending}
          >
            <Plus /> Criar cargo
          </Button>
          <p className="text-xs text-pretty text-muted-foreground">
            Do mais alto ao mais baixo. Você só gerencia cargos abaixo do seu.
          </p>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <ul aria-label="Cargos" className="flex flex-col gap-0.5 px-2 pb-3">
            {roles.map((r) => {
              const editable = canManageRole(guild, r);
              const active = selected?.id === r.id;
              return (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => pick(r.id)}
                    aria-current={active}
                    className={cn(
                      "flex min-h-10 w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-accent",
                      active &&
                        "bg-brand-500/15 font-medium shadow-[inset_2px_0_0_var(--primary)] md:bg-brand-500/15",
                    )}
                  >
                    <span
                      aria-hidden
                      className="size-3.5 shrink-0 rounded-full border border-border"
                      style={{ background: colorToHex(r.color) ?? "transparent" }}
                    />
                    <span className="min-w-0 flex-1 truncate">{r.name}</span>
                    {!editable ? (
                      <>
                        <Lock className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                        <span className="sr-only">Acima do seu cargo, somente leitura</span>
                      </>
                    ) : null}
                    <span className="tabular text-2xs text-muted-foreground">{r.position}</span>
                    <ChevronRight
                      aria-hidden
                      className="size-4 shrink-0 text-muted-foreground md:hidden"
                    />
                  </button>
                </li>
              );
            })}
          </ul>
        </ScrollArea>
      </div>
      <div className={cn("min-h-0 min-w-0 flex-1 flex-col md:flex", detail ? "flex" : "hidden")}>
        {selected ? (
          <RoleEditor
            key={`${selected.id}:${rolesVersion(selected)}`}
            guild={guild}
            role={selected}
            onBack={() => setDetail(false)}
            onDirty={setEditorDirty}
            onDeleted={() => {
              setSelectedId(undefined);
              setDetail(false);
            }}
          />
        ) : null}
      </div>
      <AlertDialog open={switchTo !== null} onOpenChange={(o) => !o && setSwitchTo(null)}>
        <AlertDialogContent>
          <AlertDialogTitle>Descartar alterações do cargo?</AlertDialogTitle>
          <AlertDialogDescription>
            Você mudou este cargo e ainda não salvou. Ao trocar de cargo, as alterações se perdem.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Continuar editando</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (switchTo) {
                  setSelectedId(switchTo);
                  setDetail(true);
                }
                setEditorDirty(false);
                setSwitchTo(null);
              }}
            >
              Descartar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

const rolesVersion = (r: RolePayload) =>
  `${r.name}|${r.color}|${r.permissions}|${r.position}|${r.mentionable}`;

function RoleEditor({
  guild,
  role,
  onBack,
  onDirty,
  onDeleted,
}: {
  guild: Guild;
  role: RolePayload;
  onBack: () => void;
  onDirty: (dirty: boolean) => void;
  onDeleted: () => void;
}) {
  const qc = useQueryClient();
  const update = useUpdateGuildRole();
  const del = useDeleteGuildRole();
  const editable = canManageRole(guild, role);
  const initialColor = colorToHex(role.color) ?? null;
  const [name, setName] = useState(role.name);
  const [color, setColor] = useState<string | null>(initialColor);
  const [perms, setPerms] = useState(role.permissions);
  const [position, setPosition] = useState(String(role.position));
  const [mentionable, setMentionable] = useState(role.mentionable);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [nameError, setNameError] = useState<string>();
  const top = myTopPosition(guild);
  const maxPosition = Number.isFinite(top) ? top - 1 : undefined;
  const dirty =
    name !== role.name ||
    color !== initialColor ||
    perms !== role.permissions ||
    mentionable !== role.mentionable ||
    position !== String(role.position);
  useReportDirty("role", dirty);
  useEffect(() => onDirty(dirty), [dirty, onDirty]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!role.is_everyone && name.trim() === "") {
      setNameError("Dê um nome ao cargo.");
      return;
    }
    setNameError(undefined);
    try {
      await update.mutateAsync({
        guildId: guild.id,
        roleId: role.id,
        data: role.is_everyone
          ? { permissions: perms }
          : {
              name: name.trim(),
              permissions: perms,
              position: Number(position),
              mentionable,
              ...(color ? { color: hexToColor(color) } : { remove_color: true }),
            },
      });
      await refreshGuilds(qc);
      toast.success("Cargo salvo.");
    } catch (err) {
      toast.error(appMessage(err));
    }
  }

  async function remove() {
    try {
      await del.mutateAsync({ guildId: guild.id, roleId: role.id });
      await refreshGuilds(qc);
      onDirty(false);
      onDeleted();
    } catch (err) {
      toast.error(appMessage(err));
    } finally {
      setConfirmDelete(false);
    }
  }

  function toggle(flag: number, on: boolean) {
    setPerms((p) => (on ? p | flag : p & ~flag));
  }

  return (
    <form
      onSubmit={save}
      noValidate
      className="flex min-h-0 flex-1 flex-col"
      aria-label={`Editar cargo ${role.name}`}
    >
      <button
        type="button"
        onClick={onBack}
        className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-4 text-sm font-medium text-brand-text md:hidden"
      >
        <ChevronLeft className="size-4" aria-hidden /> Todos os cargos
      </button>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-6 px-5 py-4 md:px-6">
          {!editable ? (
            <p
              role="note"
              className="flex items-start gap-2 rounded-lg border border-border bg-muted p-3 text-sm text-pretty text-muted-foreground"
            >
              <Lock className="mt-0.5 size-4 shrink-0" aria-hidden />
              Este cargo está acima do seu na hierarquia. Você pode ver, mas não alterar.
            </p>
          ) : null}
          {!role.is_everyone ? (
            <section aria-label="Aparência do cargo" className="flex flex-col gap-4">
              <div className="grid gap-4 sm:grid-cols-[1fr_6rem]">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="role-name">Nome do cargo</Label>
                  <Input
                    id="role-name"
                    value={name}
                    maxLength={100}
                    disabled={!editable}
                    aria-invalid={!!nameError}
                    aria-describedby={nameError ? "role-name-error" : undefined}
                    onChange={(e) => setName(e.target.value)}
                  />
                  {nameError ? (
                    <p id="role-name-error" role="alert" className="text-xs text-destructive-text">
                      {nameError}
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="role-position">Posição</Label>
                  <Input
                    id="role-position"
                    type="number"
                    min={1}
                    max={maxPosition}
                    value={position}
                    disabled={!editable}
                    onChange={(e) => setPosition(e.target.value)}
                  />
                </div>
              </div>
              <ColorPicker color={color} onChange={setColor} disabled={!editable} />
              <div className="flex min-h-14 items-center gap-3 rounded-lg border border-border px-3 py-2">
                <div className="min-w-0 flex-1">
                  <Label htmlFor="role-mentionable">
                    Permitir que qualquer pessoa mencione este cargo
                  </Label>
                  <p className="text-xs text-pretty text-muted-foreground">
                    Com isso ligado, quem escrever @{name.trim() || "cargo"} notifica os membros do
                    cargo. Sem ele, só quem pode mencionar @everyone consegue.
                  </p>
                </div>
                <Switch
                  id="role-mentionable"
                  checked={mentionable}
                  disabled={!editable}
                  onCheckedChange={setMentionable}
                />
              </div>
            </section>
          ) : (
            <p className="text-sm text-pretty text-muted-foreground">
              @everyone vale para todos os membros; só as permissões podem mudar.
            </p>
          )}
          <fieldset className="flex flex-col gap-5" disabled={!editable}>
            <legend className="mb-3 text-sm font-semibold">Permissões</legend>
            {PERMISSION_GROUPS.map((group) => (
              <section key={group.id} aria-label={group.title} className="flex flex-col">
                <h3 className="mb-1 text-xs font-medium text-muted-foreground">{group.title}</h3>
                <div className="flex flex-col divide-y divide-border/70 rounded-lg border border-border">
                  {group.items.map((p) => {
                    const flag = flagOf(p.name);
                    const on = (perms & flag) !== 0;
                    // Só concede o que tem: bit que eu não tenho não pode ser ligado.
                    const mayGrant = hasPermission(guild.permissions, flag, {
                      isOwner: guild.is_owner,
                    });
                    const admin = p.name === "ADMINISTRATOR";
                    return (
                      <div
                        key={p.name}
                        className="flex min-h-14 items-center gap-3 px-3 py-2 transition-colors hover:bg-accent/50"
                      >
                        <div className="min-w-0 flex-1">
                          <Label
                            htmlFor={`perm-${p.name}`}
                            className={cn(
                              "flex items-center gap-1.5",
                              admin && "text-warning-text",
                            )}
                          >
                            {admin ? <ShieldAlert className="size-3.5" aria-hidden /> : null}
                            {p.label}
                          </Label>
                          <p className="text-xs text-pretty text-muted-foreground">
                            {p.description}
                          </p>
                        </div>
                        <Switch
                          id={`perm-${p.name}`}
                          checked={on}
                          disabled={!editable || (!on && !mayGrant)}
                          onCheckedChange={(v) => toggle(flag, v)}
                        />
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
          </fieldset>
        </div>
      </ScrollArea>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border bg-surface-1 px-5 py-3 md:px-6">
        {!role.is_everyone ? (
          <Button
            type="button"
            variant="ghost"
            className="text-destructive-text hover:bg-danger-soft hover:text-destructive-text"
            disabled={!editable}
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 /> Excluir cargo
          </Button>
        ) : null}
        <span
          aria-live="polite"
          className={cn(
            "ml-auto hidden text-xs text-muted-foreground sm:block",
            !dirty && "invisible",
          )}
        >
          Alterações não salvas
        </span>
        <Button
          type="submit"
          className="ml-auto sm:ml-0"
          disabled={!editable || !dirty}
          loading={update.isPending}
        >
          Salvar cargo
        </Button>
      </div>
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogTitle>Excluir o cargo “{role.name}”?</AlertDialogTitle>
          <AlertDialogDescription>
            Quem tem esse cargo perde as permissões dele.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => void remove()}>Excluir</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </form>
  );
}

function ColorPicker({
  color,
  onChange,
  disabled,
}: {
  color: string | null;
  onChange: (c: string | null) => void;
  disabled: boolean;
}) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-2">
      <legend className="mb-2 flex w-full items-center justify-between gap-2">
        <span className="text-sm leading-none font-medium">Cor do cargo</span>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span
            aria-hidden
            className="size-3 rounded-full border border-border"
            style={{ background: color ?? "transparent" }}
          />
          {colorName(color)}
          {color ? <span className="tabular uppercase">{color}</span> : null}
        </span>
      </legend>
      <div className="flex flex-wrap items-center gap-2">
        {SWATCHES.map((s) => {
          const on = color?.toLowerCase() === s.hex;
          return (
            <button
              key={s.hex}
              type="button"
              disabled={disabled}
              aria-label={`Cor ${s.name}`}
              aria-pressed={on}
              onClick={() => onChange(s.hex)}
              style={{ background: s.hex }}
              className={cn(
                "size-8 rounded-full border border-black/10 transition-transform hover:scale-110 dark:border-white/15",
                on && "ring-2 ring-ring ring-offset-2 ring-offset-popover",
              )}
            />
          );
        })}
        <label className="relative flex size-8 items-center justify-center overflow-hidden rounded-full border border-dashed border-input text-muted-foreground hover:border-brand-400 hover:text-foreground has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring">
          <Plus aria-hidden className="size-4" />
          <span className="sr-only">Cor personalizada</span>
          <input
            type="color"
            value={color ?? "#99aab5"}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            className="absolute inset-0 size-full cursor-pointer opacity-0"
          />
        </label>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled || color === null}
          onClick={() => onChange(null)}
        >
          Sem cor
        </Button>
      </div>
    </fieldset>
  );
}
