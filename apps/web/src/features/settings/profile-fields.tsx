import { zodResolver } from "@hookform/resolvers/zod";
import {
  getGetMeQueryKey,
  type UpdateProfileInputBody,
  useCropProfileImage,
  useRequestBannerUpload,
  useUpdateMe,
  type View,
} from "@spook/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Image as ImageIcon, TextCursorInput } from "lucide-react";
import { useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { describedBy, Field } from "@/components/form-field";
import { type CropResult, ImageCropDialog } from "@/components/image-cropper";
import { avatarColor } from "@/components/ui/avatar";
import { BannerImage } from "@/components/ui/banner-image";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { isAnimatedImage } from "@/features/nitro/animated-file";
import { isNitroRequired, NitroRequiredDialog } from "@/features/nitro/nitro-required-dialog";
import { usePlan } from "@/features/nitro/use-plan";
import { SettingsGroup } from "@/features/settings/ui";
import { useT } from "@/i18n";
import { colorToHex, hexToColor } from "@/lib/colors";
import { applyServerError, messageFor } from "@/lib/errors";
import { uploadCropped } from "@/lib/image-upload";
import {
  BIO_MAX,
  PRONOUNS_MAX,
  type ProfileTextForm,
  profileTextSchema,
  validateAvatar,
} from "@/lib/schemas";
import { applyUserUpdate, profileOf } from "@/lib/user-cache";

/** Grava campos do perfil e atualiza o cache de `GET /users/me`. */
export function useSaveProfile() {
  const qc = useQueryClient();
  const update = useUpdateMe();
  return async (data: UpdateProfileInputBody) => {
    const res = await update.mutateAsync({ data });
    qc.setQueryData(getGetMeQueryKey(), res);
    // Os outros lugares (membros, mensagens, DMs, chamada) mudam já; o USER_UPDATE do servidor confirma depois.
    applyUserUpdate(qc, profileOf(res), res.id);
    return res;
  };
}

/** Bio e pronomes. */
export function AboutCard({ me }: { me: View }) {
  const { t } = useT();
  const save = useSaveProfile();
  const {
    register,
    handleSubmit,
    setError,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<ProfileTextForm>({
    resolver: zodResolver(profileTextSchema),
    defaultValues: { bio: me.bio ?? "", pronouns: me.pronouns ?? "" },
  });
  const bioLength = [...(watch("bio") ?? "")].length;

  const onSubmit = handleSubmit(async ({ bio, pronouns }) => {
    try {
      await save({ bio, pronouns });
      toast.success(t("settings.profile.updated"));
    } catch (e) {
      if (!applyServerError(e, setError)) toast.error(messageFor(e));
    }
  });

  return (
    <SettingsGroup
      icon={TextCursorInput}
      title={t("settings.profile.aboutTitle")}
      description={t("settings.profile.aboutDescription")}
    >
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <Field
          id="pronouns"
          label={t("settings.profile.pronouns")}
          hint={t("settings.profile.pronounsHint")}
          error={errors.pronouns?.message}
        >
          <Input
            id="pronouns"
            maxLength={PRONOUNS_MAX}
            aria-invalid={!!errors.pronouns}
            aria-describedby={describedBy(
              "pronouns",
              errors.pronouns?.message,
              t("settings.profile.pronounsHint"),
            )}
            {...register("pronouns")}
          />
        </Field>
        <Field id="bio" label={t("settings.profile.bio")} error={errors.bio?.message}>
          <Textarea
            id="bio"
            rows={4}
            maxLength={BIO_MAX}
            aria-invalid={!!errors.bio}
            aria-describedby={describedBy("bio", errors.bio?.message)}
            {...register("bio")}
          />
          <p className="text-right text-xs text-muted-foreground" aria-live="off">
            {`${bioLength}/${BIO_MAX}`}
          </p>
        </Field>
        <Button type="submit" className="self-start" loading={isSubmitting}>
          {t("settings.profile.save")}
        </Button>
      </form>
    </SettingsGroup>
  );
}

const DEFAULT_COLOR = "#5865f2";

/** Banner do perfil: imagem (com prévia) OU cor sólida. */
export function BannerCard({ me }: { me: View }) {
  const { t } = useT();
  const save = useSaveProfile();
  const requestUpload = useRequestBannerUpload();
  const cropGif = useCropProfileImage();
  const [picked, setPicked] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savedHex = me.banner_color != null ? colorToHex(me.banner_color) : undefined;
  const [pickedColor, setPickedColor] = useState(savedHex ?? DEFAULT_COLOR);
  const busy = progress !== null || saving;
  const hasBanner = !!me.banner_url || me.banner_color != null;
  const [touched, setTouched] = useState(false);
  const showColor = !me.banner_url && (me.banner_color != null || touched);
  const fallback = avatarColor(me.id);

  const plan = usePlan();
  const [nitroOpen, setNitroOpen] = useState(false);

  async function onFile(file: File | undefined) {
    if (!file) return;
    const problem = validateAvatar(file);
    setFileError(problem);
    if (fileInput.current) fileInput.current.value = "";
    if (problem) return;
    // Sem Nitro, GIF/WebP/APNG animado nem chega ao envio: avisa antes (o servidor também recusa).
    if (!plan.limits.animated_banner && (await isAnimatedImage(file))) {
      setNitroOpen(true);
      return;
    }
    setPicked(file);
  }

  async function upload(result: CropResult) {
    setPicked(null);
    setProgress(0);
    try {
      const { key, fallback } = await uploadCropped({
        result,
        presign: (content_type, size) =>
          requestUpload.mutateAsync({ data: { content_type, size } }),
        cropGif: (key, r) =>
          cropGif.mutateAsync({ data: { key, x: r.x, y: r.y, width: r.w, height: r.h } }),
        onProgress: setProgress,
      });
      await save({ banner_key: key });
      toast.success(t("settings.profile.bannerUpdated"));
      if (fallback) toast.info(t("crop.gifFallback"));
    } catch (e) {
      if (isNitroRequired(e)) setNitroOpen(true);
      else
        toast.error(
          e instanceof Error && !("status" in e)
            ? t("settings.profile.uploadFailed")
            : messageFor(e),
        );
    } finally {
      setProgress(null);
    }
  }

  async function act(data: UpdateProfileInputBody, ok: string) {
    setSaving(true);
    try {
      await save(data);
      toast.success(ok);
    } catch (e) {
      toast.error(messageFor(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsGroup
      icon={ImageIcon}
      title={t("settings.profile.bannerTitle")}
      description={t("settings.profile.bannerDescription")}
    >
      <div
        data-testid="banner-preview"
        role="img"
        aria-label={t("settings.profile.bannerPreview")}
        className="aspect-[4/1] w-full max-w-md overflow-hidden rounded-lg border border-border bg-cover bg-center"
        style={{
          background: me.banner_url
            ? undefined
            : showColor
              ? pickedColor
              : `linear-gradient(120deg, ${fallback.from}, ${fallback.to})`,
        }}
      >
        {me.banner_url ? (
          <BannerImage
            url={me.banner_url}
            ownerPlan={me.plan ?? "free"}
            className="size-full object-cover"
          />
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileInput}
          id="banner-file"
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="sr-only"
          onChange={(e) => void onFile(e.target.files?.[0])}
          disabled={busy}
          aria-label={t("settings.profile.bannerUpload")}
        />
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => fileInput.current?.click()}
        >
          {progress !== null ? t("settings.profile.uploading") : t("settings.profile.uploadImage")}
        </Button>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">{t("settings.profile.color")}</span>
          <input
            type="color"
            value={pickedColor}
            onChange={(e) => {
              setTouched(true);
              setPickedColor(e.target.value);
            }}
            disabled={busy}
            aria-label={t("settings.profile.bannerColor")}
            className="h-9 w-12 cursor-pointer rounded-md border border-input bg-field p-1 disabled:cursor-not-allowed"
          />
        </label>
        <Button
          type="button"
          variant="outline"
          disabled={busy || (me.banner_color != null && savedHex === pickedColor && !me.banner_url)}
          onClick={() =>
            void act({ banner_color: hexToColor(pickedColor) }, t("settings.profile.bannerUpdated"))
          }
        >
          {t("settings.profile.useColor")}
        </Button>
        {hasBanner ? (
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => void act({ remove_banner: true }, t("settings.profile.bannerRemoved"))}
          >
            {t("settings.profile.remove")}
          </Button>
        ) : null}
      </div>
      {progress !== null ? (
        <progress
          className="h-2 w-48 accent-primary"
          max={100}
          value={progress}
          aria-label={t("settings.profile.uploadProgress")}
        />
      ) : null}
      {fileError ? (
        <p role="alert" className="text-xs text-destructive-text">
          {fileError}
        </p>
      ) : null}
      <ImageCropDialog
        file={picked}
        kind="banner"
        onCancel={() => setPicked(null)}
        onApply={(r) => void upload(r)}
      />
      <NitroRequiredDialog open={nitroOpen} onOpenChange={setNitroOpen} />
    </SettingsGroup>
  );
}
