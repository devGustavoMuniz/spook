import { zodResolver } from "@hookform/resolvers/zod";
import {
  useDeleteGuild,
  useGetMe,
  useRequestGuildIconUpload,
  useTransferGuild,
  useUpdateGuild,
} from "@spook/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ImagePlus, Trash2, TriangleAlert } from "lucide-react";
import { useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { describedBy, Field } from "@/components/form-field";
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
import { DialogBody } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { memberName, useGuildMembers } from "@/features/members/use-members";
import { appMessage } from "@/lib/app-errors";
import { type Guild, initials } from "@/lib/guild";
import { refreshGuilds, removeGuild } from "@/lib/guild-cache";
import { type GuildNameForm, guildNameSchema, validateAvatar } from "@/lib/schemas";
import { putWithProgress } from "@/lib/upload";
import { useReportDirty } from "./dirty";

export function GeneralTab({ guild, onClose }: { guild: Guild; onClose: () => void }) {
  return (
    <DialogBody className="gap-8">
      <NameForm guild={guild} />
      <IconSection guild={guild} />
      {guild.is_owner ? <DangerZone guild={guild} onClose={onClose} /> : null}
    </DialogBody>
  );
}

function NameForm({ guild }: { guild: Guild }) {
  const qc = useQueryClient();
  const update = useUpdateGuild();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<GuildNameForm>({
    resolver: zodResolver(guildNameSchema),
    values: { name: guild.name },
  });
  useReportDirty("guild-name", isDirty);
  const onSubmit = handleSubmit(async ({ name }) => {
    try {
      await update.mutateAsync({ guildId: guild.id, data: { name } });
      await refreshGuilds(qc);
      toast.success("Servidor atualizado.");
    } catch (e) {
      toast.error(appMessage(e));
    }
  });
  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-3">
      <Field id="settings-guild-name" label="Nome do servidor" error={errors.name?.message}>
        <Input
          id="settings-guild-name"
          maxLength={100}
          aria-invalid={!!errors.name}
          aria-describedby={describedBy("settings-guild-name", errors.name?.message)}
          {...register("name")}
        />
      </Field>
      <Button type="submit" className="self-start" loading={isSubmitting} disabled={!isDirty}>
        Salvar nome
      </Button>
    </form>
  );
}

function IconSection({ guild }: { guild: Guild }) {
  const qc = useQueryClient();
  const requestUpload = useRequestGuildIconUpload();
  const update = useUpdateGuild();
  const fileInput = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const busy = progress !== null;

  async function onFile(file: File | undefined) {
    if (!file) return;
    const problem = validateAvatar(file);
    setFileError(problem);
    if (problem) return;
    setProgress(0);
    try {
      const { upload_url, key } = await requestUpload.mutateAsync({
        guildId: guild.id,
        data: {
          content_type: file.type as "image/png" | "image/jpeg" | "image/webp",
          size: file.size,
        },
      });
      await putWithProgress(upload_url, file, setProgress);
      await update.mutateAsync({ guildId: guild.id, data: { icon_key: key } });
      await refreshGuilds(qc);
      toast.success("Ícone atualizado.");
    } catch (e) {
      toast.error(
        e instanceof Error && !("status" in e)
          ? "Não foi possível enviar a imagem."
          : appMessage(e),
      );
    } finally {
      setProgress(null);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function remove() {
    try {
      await update.mutateAsync({ guildId: guild.id, data: { icon_key: "" } });
      await refreshGuilds(qc);
      toast.success("Ícone removido.");
    } catch (e) {
      toast.error(appMessage(e));
    }
  }

  return (
    <section aria-labelledby="icon-title" className="flex flex-col gap-3">
      <div>
        <h3 id="icon-title" className="text-sm font-semibold">
          Ícone do servidor
        </h3>
        <p className="text-xs text-muted-foreground">
          PNG, JPEG ou WebP. Aparece na barra de servidores.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex size-20 items-center justify-center overflow-hidden rounded-2xl border border-border bg-secondary text-xl font-semibold">
          {guild.icon_url ? (
            <img src={guild.icon_url} alt="Ícone atual" className="size-full object-cover" />
          ) : (
            initials(guild.name)
          )}
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="sr-only"
              aria-label="Arquivo do ícone"
              onChange={(e) => void onFile(e.target.files?.[0])}
              disabled={busy}
            />
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
            >
              <ImagePlus /> {busy ? "Enviando…" : "Trocar ícone"}
            </Button>
            {guild.icon_key ? (
              <Button type="button" variant="ghost" disabled={busy} onClick={remove}>
                <Trash2 /> Remover
              </Button>
            ) : null}
          </div>
          {busy ? (
            <progress
              className="h-2 w-48 accent-primary"
              max={100}
              value={progress ?? 0}
              aria-label="Progresso do envio"
            />
          ) : null}
          {fileError ? (
            <p role="alert" className="text-xs text-destructive-text">
              {fileError}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function DangerZone({ guild, onClose }: { guild: Guild; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: me } = useGetMe();
  const members = useGuildMembers(guild.id);
  const transfer = useTransferGuild();
  const del = useDeleteGuild();
  const [target, setTarget] = useState<string>("");
  const [confirmTransfer, setConfirmTransfer] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const others = (members.data?.members ?? []).filter((m) => m.user_id !== me?.id);
  const targetMember = others.find((m) => m.user_id === target);

  async function doTransfer() {
    try {
      await transfer.mutateAsync({ guildId: guild.id, data: { user_id: target } });
      await refreshGuilds(qc);
      toast.success("Posse transferida.");
      onClose();
    } catch (e) {
      toast.error(appMessage(e));
    } finally {
      setConfirmTransfer(false);
    }
  }

  async function doDelete() {
    try {
      await del.mutateAsync({ guildId: guild.id });
      removeGuild(qc, guild.id);
      onClose();
      await navigate({ to: "/" });
    } catch (e) {
      toast.error(appMessage(e));
    } finally {
      setConfirmDelete(false);
    }
  }

  return (
    <section
      aria-labelledby="danger-title"
      className="flex flex-col gap-5 rounded-xl border border-destructive/40 bg-danger-soft/40 p-4"
    >
      <h3
        id="danger-title"
        className="flex items-center gap-2 text-sm font-semibold text-destructive-text"
      >
        <TriangleAlert className="size-4" aria-hidden /> Zona de perigo
      </h3>
      <div className="flex flex-col gap-2">
        <p className="text-sm text-pretty text-muted-foreground">
          Transfira a posse para outro membro. Você continua no servidor, sem os poderes de dono.
        </p>
        <div className="flex flex-wrap gap-2">
          <div className="min-w-48 flex-1">
            <Select value={target} onValueChange={setTarget}>
              <SelectTrigger aria-label="Novo dono">
                <SelectValue placeholder="Escolha um membro" />
              </SelectTrigger>
              <SelectContent>
                {others.map((m) => (
                  <SelectItem key={m.user_id} value={m.user_id}>
                    {memberName(m)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button variant="outline" disabled={!target} onClick={() => setConfirmTransfer(true)}>
            Transferir posse
          </Button>
        </div>
      </div>
      <div className="flex flex-col gap-2 border-t border-destructive/20 pt-5">
        <p className="text-sm text-pretty text-muted-foreground">
          Excluir apaga canais, cargos, convites e mensagens para todos.
        </p>
        <Button variant="destructive" className="self-start" onClick={() => setConfirmDelete(true)}>
          Excluir servidor
        </Button>
      </div>
      <AlertDialog open={confirmTransfer} onOpenChange={setConfirmTransfer}>
        <AlertDialogContent>
          <AlertDialogTitle>
            Transferir {guild.name} para {targetMember ? memberName(targetMember) : ""}?
          </AlertDialogTitle>
          <AlertDialogDescription>Só o novo dono poderá desfazer isso.</AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => void doTransfer()}>Transferir</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogTitle>Excluir {guild.name}?</AlertDialogTitle>
          <AlertDialogDescription>Esta ação não pode ser desfeita.</AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => void doDelete()}>Excluir servidor</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
