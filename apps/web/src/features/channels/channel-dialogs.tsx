import { zodResolver } from "@hookform/resolvers/zod";
import {
  type ChannelPayload,
  type CreateChannelInputBodyType,
  useCreateChannel,
  useDeleteChannel,
  useUpdateChannel,
} from "@spook/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Controller, useForm } from "react-hook-form";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { appMessage } from "@/lib/app-errors";
import { CHANNEL_CATEGORY, CHANNEL_TEXT, channelsOf, type Guild } from "@/lib/guild";
import { refreshGuilds } from "@/lib/guild-cache";
import { type ChannelForm, channelFormSchema } from "@/lib/schemas";

const NO_CATEGORY = "none";

export function CreateChannelDialog({
  guild,
  open,
  onOpenChange,
  parentId,
  initialType = CHANNEL_TEXT,
}: {
  guild: Guild;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  parentId?: string;
  initialType?: number;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const create = useCreateChannel();
  const categories = channelsOf(guild).filter((c) => c.type === CHANNEL_CATEGORY);
  const {
    register,
    control,
    handleSubmit,
    watch,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<ChannelForm>({
    resolver: zodResolver(channelFormSchema),
    values: { name: "", type: String(initialType) as "0", parent_id: parentId ?? NO_CATEGORY },
  });
  const type = watch("type");

  const onSubmit = handleSubmit(async (f) => {
    try {
      const channel = await create.mutateAsync({
        guildId: guild.id,
        data: {
          name: f.name,
          type: Number(f.type) as CreateChannelInputBodyType,
          ...(f.type !== "2" && f.parent_id !== NO_CATEGORY ? { parent_id: f.parent_id } : {}),
        },
      });
      await refreshGuilds(qc);
      reset();
      onOpenChange(false);
      if (channel.type === CHANNEL_TEXT)
        await navigate({
          to: "/channels/$guildId/$channelId",
          params: { guildId: guild.id, channelId: channel.id },
        });
    } catch (e) {
      toast.error(appMessage(e));
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Criar canal</DialogTitle>
          <DialogDescription>
            Canais de voz aparecem na lista, mas ainda não dá para entrar.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
          <Field id="channel-type" label="Tipo">
            <Controller
              control={control}
              name="type"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="channel-type" aria-label="Tipo do canal">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0">Texto</SelectItem>
                    <SelectItem value="1">Voz</SelectItem>
                    <SelectItem value="2">Categoria</SelectItem>
                  </SelectContent>
                </Select>
              )}
            />
          </Field>
          <Field id="channel-name" label="Nome" error={errors.name?.message}>
            <Input
              id="channel-name"
              autoFocus
              maxLength={100}
              aria-invalid={!!errors.name}
              aria-describedby={describedBy("channel-name", errors.name?.message)}
              {...register("name")}
            />
          </Field>
          {type !== "2" && categories.length > 0 ? (
            <Field id="channel-parent" label="Categoria">
              <Controller
                control={control}
                name="parent_id"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="channel-parent" aria-label="Categoria do canal">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_CATEGORY}>Sem categoria</SelectItem>
                      {categories.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </Field>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Criando…" : "Criar"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function RenameChannelDialog({
  channel,
  onClose,
}: {
  channel: ChannelPayload | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const update = useUpdateChannel();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<{ name: string }>({
    resolver: zodResolver(channelFormSchema.pick({ name: true })),
    values: { name: channel?.name ?? "" },
  });

  const onSubmit = handleSubmit(async ({ name }) => {
    if (!channel) return;
    try {
      await update.mutateAsync({ channelId: channel.id, data: { name } });
      await refreshGuilds(qc);
      onClose();
    } catch (e) {
      toast.error(appMessage(e));
    }
  });

  return (
    <Dialog open={!!channel} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Renomear {channel?.type === CHANNEL_CATEGORY ? "categoria" : "canal"}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
          <Field id="rename-channel" label="Nome" error={errors.name?.message}>
            <Input
              id="rename-channel"
              autoFocus
              maxLength={100}
              aria-invalid={!!errors.name}
              aria-describedby={describedBy("rename-channel", errors.name?.message)}
              {...register("name")}
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              Salvar
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function DeleteChannelDialog({
  guild,
  channel,
  activeChannelId,
  onClose,
}: {
  guild: Guild;
  channel: ChannelPayload | null;
  activeChannelId?: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const del = useDeleteChannel();
  const isCategory = channel?.type === CHANNEL_CATEGORY;

  async function confirm() {
    if (!channel) return;
    try {
      await del.mutateAsync({ channelId: channel.id });
      await refreshGuilds(qc);
      qc.removeQueries({ queryKey: [`/api/channels/${channel.id}/messages`] });
      if (channel.id === activeChannelId)
        await navigate({ to: "/channels/$guildId", params: { guildId: guild.id } });
    } catch (e) {
      toast.error(appMessage(e));
    } finally {
      onClose();
    }
  }

  return (
    <AlertDialog open={!!channel} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogTitle>
          Excluir {isCategory ? "categoria" : "canal"} “{channel?.name}”?
        </AlertDialogTitle>
        <AlertDialogDescription>
          {isCategory
            ? "Os canais dentro dela ficam sem categoria."
            : "As mensagens do canal serão apagadas. Esta ação não pode ser desfeita."}
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancelar</AlertDialogCancel>
          <AlertDialogAction onClick={() => void confirm()}>Excluir</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
