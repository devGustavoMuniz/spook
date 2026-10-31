import {
  hasPermission,
  type RolePayload,
  useCreateGuildRole,
  useDeleteGuildRole,
  useUpdateGuildRole,
} from "@spook/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Lock, Plus } from "lucide-react";
import { useState } from "react";
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
import { Switch } from "@/components/ui/switch";
import { appMessage } from "@/lib/app-errors";
import { colorToHex, hexToColor } from "@/lib/colors";
import { canManageRole, type Guild, myTopPosition, rolesOf } from "@/lib/guild";
import { refreshGuilds } from "@/lib/guild-cache";
import { flagOf, PERMISSION_LABELS } from "./permission-labels";

export function RolesTab({ guild }: { guild: Guild }) {
  const qc = useQueryClient();
  const create = useCreateGuildRole();
  const roles = rolesOf(guild);
  const [selectedId, setSelectedId] = useState<string | undefined>(roles[0]?.id);
  const selected = roles.find((r) => r.id === selectedId) ?? roles[0];

  async function createRole() {
    try {
      const role = await create.mutateAsync({ guildId: guild.id, data: { name: "Novo cargo" } });
      await refreshGuilds(qc);
      setSelectedId(role.id);
    } catch (e) {
      toast.error(appMessage(e));
    }
  }

  return (
    <div className="grid gap-4 md:grid-cols-[14rem_1fr]">
      <div className="flex flex-col gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => void createRole()}
          disabled={create.isPending}
        >
          <Plus /> Criar cargo
        </Button>
        <p className="text-xs text-muted-foreground">
          Do mais alto ao mais baixo. Você só gerencia cargos abaixo do seu.
        </p>
        <ul aria-label="Cargos" className="flex max-h-80 flex-col gap-0.5 overflow-y-auto">
          {roles.map((r) => {
            const editable = canManageRole(guild, r);
            return (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(r.id)}
                  aria-current={selected?.id === r.id}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent ${
                    selected?.id === r.id ? "bg-accent" : ""
                  }`}
                >
                  <span
                    aria-hidden
                    className="size-3 shrink-0 rounded-full border"
                    style={{ background: colorToHex(r.color) ?? "transparent" }}
                  />
                  <span className="min-w-0 flex-1 truncate">{r.name}</span>
                  {!editable ? (
                    <>
                      <Lock className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="sr-only">Acima do seu cargo, somente leitura</span>
                    </>
                  ) : null}
                  <span className="text-[11px] text-muted-foreground">{r.position}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      {selected ? (
        <RoleEditor
          key={`${selected.id}:${rolesVersion(selected)}`}
          guild={guild}
          role={selected}
          onDeleted={() => setSelectedId(undefined)}
        />
      ) : null}
    </div>
  );
}

const rolesVersion = (r: RolePayload) => `${r.name}|${r.color}|${r.permissions}|${r.position}`;

function RoleEditor({
  guild,
  role,
  onDeleted,
}: {
  guild: Guild;
  role: RolePayload;
  onDeleted: () => void;
}) {
  const qc = useQueryClient();
  const update = useUpdateGuildRole();
  const del = useDeleteGuildRole();
  const editable = canManageRole(guild, role);
  const [name, setName] = useState(role.name);
  const [color, setColor] = useState<string | null>(colorToHex(role.color) ?? null);
  const [perms, setPerms] = useState(role.permissions);
  const [position, setPosition] = useState(String(role.position));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const top = myTopPosition(guild);
  const maxPosition = Number.isFinite(top) ? top - 1 : undefined;

  async function save(e: React.FormEvent) {
    e.preventDefault();
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
    <form onSubmit={save} className="flex flex-col gap-4" aria-label={`Editar cargo ${role.name}`}>
      {!editable ? (
        <p role="note" className="rounded-md border p-3 text-sm text-muted-foreground">
          Este cargo está acima do seu na hierarquia. Você pode ver, mas não alterar.
        </p>
      ) : null}
      {!role.is_everyone ? (
        <div className="grid gap-4 sm:grid-cols-[1fr_auto_6rem]">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="role-name">Nome do cargo</Label>
            <Input
              id="role-name"
              value={name}
              maxLength={100}
              disabled={!editable}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="role-color">Cor</Label>
            <div className="flex items-center gap-2">
              <input
                id="role-color"
                type="color"
                value={color ?? "#99aab5"}
                disabled={!editable}
                onChange={(e) => setColor(e.target.value)}
                className="h-9 w-12 rounded-md border border-input bg-transparent p-1"
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!editable || color === null}
                onClick={() => setColor(null)}
              >
                Sem cor
              </Button>
            </div>
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
      ) : (
        <p className="text-sm text-muted-foreground">
          @everyone vale para todos os membros; só as permissões podem mudar.
        </p>
      )}
      <fieldset className="flex flex-col gap-1" disabled={!editable}>
        <legend className="mb-1 text-sm font-medium">Permissões</legend>
        {PERMISSION_LABELS.map((p) => {
          const flag = flagOf(p.name);
          const on = (perms & flag) !== 0;
          // Só concede o que tem: bit que eu não tenho não pode ser ligado.
          const mayGrant = hasPermission(guild.permissions, flag, { isOwner: guild.is_owner });
          return (
            <div
              key={p.name}
              className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-accent/50"
            >
              <div className="min-w-0 flex-1">
                <Label htmlFor={`perm-${p.name}`}>{p.label}</Label>
                <p className="text-xs text-muted-foreground">{p.description}</p>
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
      </fieldset>
      <div className="flex flex-wrap justify-between gap-2">
        <Button type="submit" disabled={!editable || update.isPending}>
          Salvar cargo
        </Button>
        {!role.is_everyone ? (
          <Button
            type="button"
            variant="destructive"
            disabled={!editable}
            onClick={() => setConfirmDelete(true)}
          >
            Excluir cargo
          </Button>
        ) : null}
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
