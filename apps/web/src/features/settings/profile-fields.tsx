import { zodResolver } from "@hookform/resolvers/zod";
import {
  getGetMeQueryKey,
  type UpdateProfileInputBody,
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
import { avatarColor } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SettingsGroup } from "@/features/settings/ui";
import { colorToHex, hexToColor } from "@/lib/colors";
import { applyServerError, messageFor } from "@/lib/errors";
import {
  BIO_MAX,
  PRONOUNS_MAX,
  type ProfileTextForm,
  profileTextSchema,
  validateAvatar,
} from "@/lib/schemas";
import { putWithProgress } from "@/lib/upload";

/** Grava campos do perfil e atualiza o cache de `GET /users/me`. */
export function useSaveProfile() {
  const qc = useQueryClient();
  const update = useUpdateMe();
  return async (data: UpdateProfileInputBody) => {
    const res = await update.mutateAsync({ data });
    qc.setQueryData(getGetMeQueryKey(), res);
    return res;
  };
}

/** Bio e pronomes. */
export function AboutCard({ me }: { me: View }) {
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
      toast.success("Perfil atualizado.");
    } catch (e) {
      if (!applyServerError(e, setError)) toast.error(messageFor(e));
    }
  });

  return (
    <SettingsGroup
      icon={TextCursorInput}
      title="Sobre você"
      description="Aparece no seu cartão de perfil, para quem clicar no seu nome."
    >
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <Field
          id="pronouns"
          label="Pronomes"
          hint="Por exemplo: ela/dela, ele/dele, elu/delu."
          error={errors.pronouns?.message}
        >
          <Input
            id="pronouns"
            maxLength={PRONOUNS_MAX}
            aria-invalid={!!errors.pronouns}
            aria-describedby={describedBy(
              "pronouns",
              errors.pronouns?.message,
              "Por exemplo: ela/dela, ele/dele, elu/delu.",
            )}
            {...register("pronouns")}
          />
        </Field>
        <Field id="bio" label="Bio" error={errors.bio?.message}>
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
          Salvar
        </Button>
      </form>
    </SettingsGroup>
  );
}

const DEFAULT_COLOR = "#5865f2";

/** Banner do perfil: imagem (com prévia) OU cor sólida. */
export function BannerCard({ me }: { me: View }) {
  const save = useSaveProfile();
  const requestUpload = useRequestBannerUpload();
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

  async function onFile(file: File | undefined) {
    if (!file) return;
    const problem = validateAvatar(file);
    setFileError(problem);
    if (problem) return;
    setProgress(0);
    try {
      const { upload_url, key } = await requestUpload.mutateAsync({
        data: {
          content_type: file.type as "image/png" | "image/jpeg" | "image/webp" | "image/gif",
          size: file.size,
        },
      });
      await putWithProgress(upload_url, file, setProgress);
      await save({ banner_key: key });
      toast.success("Banner atualizado.");
    } catch (e) {
      toast.error(
        e instanceof Error && !("status" in e)
          ? "Não foi possível enviar a imagem."
          : messageFor(e),
      );
    } finally {
      setProgress(null);
      if (fileInput.current) fileInput.current.value = "";
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
      title="Banner"
      description="Uma imagem (PNG, JPEG, WebP ou GIF, até 5 MB) ou uma cor sólida no topo do seu cartão de perfil."
    >
      <div
        data-testid="banner-preview"
        role="img"
        aria-label="Prévia do banner"
        className="h-24 w-full max-w-md overflow-hidden rounded-lg border border-border bg-cover bg-center"
        style={{
          background: me.banner_url
            ? undefined
            : showColor
              ? pickedColor
              : `linear-gradient(120deg, ${fallback.from}, ${fallback.to})`,
        }}
      >
        {me.banner_url ? (
          <img src={me.banner_url} alt="" className="size-full object-cover" />
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
          aria-label="Enviar imagem de banner"
        />
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => fileInput.current?.click()}
        >
          {progress !== null ? "Enviando…" : "Enviar imagem"}
        </Button>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Cor</span>
          <input
            type="color"
            value={pickedColor}
            onChange={(e) => {
              setTouched(true);
              setPickedColor(e.target.value);
            }}
            disabled={busy}
            aria-label="Cor do banner"
            className="h-9 w-12 cursor-pointer rounded-md border border-input bg-field p-1 disabled:cursor-not-allowed"
          />
        </label>
        <Button
          type="button"
          variant="outline"
          disabled={busy || (me.banner_color != null && savedHex === pickedColor && !me.banner_url)}
          onClick={() => void act({ banner_color: hexToColor(pickedColor) }, "Banner atualizado.")}
        >
          Usar cor
        </Button>
        {hasBanner ? (
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => void act({ remove_banner: true }, "Banner removido.")}
          >
            Remover
          </Button>
        ) : null}
      </div>
      {progress !== null ? (
        <progress
          className="h-2 w-48 accent-primary"
          max={100}
          value={progress}
          aria-label="Progresso do envio do banner"
        />
      ) : null}
      {fileError ? (
        <p role="alert" className="text-xs text-destructive-text">
          {fileError}
        </p>
      ) : null}
    </SettingsGroup>
  );
}
