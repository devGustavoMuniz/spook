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
import { Hash, Pencil, Volume2 } from "lucide-react";
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
  DialogActions,
  DialogBody,
  DialogContent,
  DialogHead,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/i18n";
import { appMessage } from "@/lib/app-errors";
import { CHANNEL_CATEGORY, CHANNEL_TEXT, channelsOf, type Guild } from "@/lib/guild";
import { refreshGuilds } from "@/lib/guild-cache";
import {
  type ChannelEditForm,
  type ChannelForm,
  channelEditSchema,
  channelFormSchema,
} from "@/lib/schemas";

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
  const { t } = useT();
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
      <DialogContent flush>
        <DialogHead
          icon={type === "1" ? Volume2 : Hash}
          title={t("channels.dialog.createTitle")}
          description={t("channels.dialog.createDesc")}
        />
        <form onSubmit={onSubmit} noValidate className="flex min-h-0 flex-1 flex-col">
          <DialogBody>
            <Field id="channel-type" label={t("channels.dialog.type")}>
              <Controller
                control={control}
                name="type"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="channel-type" aria-label={t("channels.dialog.typeAria")}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0">{t("channels.dialog.typeText")}</SelectItem>
                      <SelectItem value="1">{t("channels.dialog.typeVoice")}</SelectItem>
                      <SelectItem value="2">{t("channels.dialog.typeCategory")}</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              />
            </Field>
            <Field id="channel-name" label={t("channels.dialog.name")} error={errors.name?.message}>
              <Input
                id="channel-name"
                autoFocus
                maxLength={100}
                placeholder={
                  type === "2" ? t("channels.dialog.phCategory") : t("channels.dialog.phChannel")
                }
                aria-invalid={!!errors.name}
                aria-describedby={describedBy("channel-name", errors.name?.message)}
                {...register("name")}
              />
            </Field>
            {type !== "2" && categories.length > 0 ? (
              <Field id="channel-parent" label={t("channels.dialog.category")}>
                <Controller
                  control={control}
                  name="parent_id"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger
                        id="channel-parent"
                        aria-label={t("channels.dialog.categoryAria")}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NO_CATEGORY}>
                          {t("channels.dialog.noCategory")}
                        </SelectItem>
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
          </DialogBody>
          <DialogActions>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t("channels.dialog.cancel")}
            </Button>
            <Button type="submit" loading={isSubmitting}>
              {t("channels.dialog.create")}
            </Button>
          </DialogActions>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Editar canal: nome e, nos canais de texto, o tópico (MANAGE_CHANNELS). Categorias só têm nome. */
export function RenameChannelDialog({
  channel,
  onClose,
}: {
  channel: ChannelPayload | null;
  onClose: () => void;
}) {
  const { t } = useT();
  const qc = useQueryClient();
  const update = useUpdateChannel();
  const hasTopic = channel?.type === CHANNEL_TEXT;
  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<ChannelEditForm>({
    resolver: zodResolver(channelEditSchema),
    values: { name: channel?.name ?? "", topic: channel?.topic ?? "" },
  });
  const topicLength = [...(watch("topic") ?? "")].length;

  const onSubmit = handleSubmit(async ({ name, topic }) => {
    if (!channel) return;
    try {
      await update.mutateAsync({
        channelId: channel.id,
        data: hasTopic ? { name, topic } : { name },
      });
      await refreshGuilds(qc);
      onClose();
    } catch (e) {
      toast.error(appMessage(e));
    }
  });

  return (
    <Dialog open={!!channel} onOpenChange={(o) => !o && onClose()}>
      <DialogContent flush size="sm">
        <DialogHead
          icon={Pencil}
          title={
            channel?.type === CHANNEL_CATEGORY
              ? t("channels.dialog.renameCategory")
              : t("channels.dialog.editChannel")
          }
        />
        <form onSubmit={onSubmit} noValidate className="flex min-h-0 flex-1 flex-col">
          <DialogBody>
            <Field
              id="rename-channel"
              label={t("channels.dialog.name")}
              error={errors.name?.message}
            >
              <Input
                id="rename-channel"
                autoFocus
                maxLength={100}
                aria-invalid={!!errors.name}
                aria-describedby={describedBy("rename-channel", errors.name?.message)}
                {...register("name")}
              />
            </Field>
            {hasTopic ? (
              <Field
                id="channel-topic"
                label={t("channels.dialog.topic")}
                hint={t("channels.dialog.topicHint", { count: topicLength })}
                error={errors.topic?.message}
              >
                <Textarea
                  id="channel-topic"
                  rows={3}
                  placeholder={t("channels.dialog.topicPh")}
                  aria-invalid={!!errors.topic}
                  aria-describedby={describedBy("channel-topic", errors.topic?.message)}
                  {...register("topic")}
                />
              </Field>
            ) : null}
          </DialogBody>
          <DialogActions>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("channels.dialog.cancel")}
            </Button>
            <Button type="submit" loading={isSubmitting}>
              {t("channels.dialog.save")}
            </Button>
          </DialogActions>
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
  const { t } = useT();
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
          {isCategory
            ? t("channels.dialog.deleteCategoryTitle", { name: channel?.name ?? "" })
            : t("channels.dialog.deleteChannelTitle", { name: channel?.name ?? "" })}
        </AlertDialogTitle>
        <AlertDialogDescription>
          {isCategory
            ? t("channels.dialog.deleteCategoryBody")
            : t("channels.dialog.deleteChannelBody")}
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("channels.dialog.cancel")}</AlertDialogCancel>
          <AlertDialogAction onClick={() => void confirm()}>
            {t("channels.dialog.delete")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
