import { zodResolver } from "@hookform/resolvers/zod";
import { useGetMe, useRequestAvatarUpload, type View } from "@spook/shared";
import { AtSign, Image as ImageIcon, Mail, UserRound } from "lucide-react";
import { useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { Avatar } from "@/components/avatar";
import { describedBy, Field } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AboutCard, BannerCard, useSaveProfile } from "@/features/settings/profile-fields";
import { SecuritySection } from "@/features/settings/security";
import { SettingsGroup } from "@/features/settings/ui";
import { useT } from "@/i18n";
import { applyServerError, messageFor } from "@/lib/errors";
import { type ProfileForm, profileSchema, validateAvatar } from "@/lib/schemas";
import { putWithProgress } from "@/lib/upload";

export function ProfilePage() {
  const { data: me } = useGetMe();
  if (!me) return null;
  return (
    <div className="flex flex-col gap-6">
      <AvatarCard me={me} />
      <BannerCard me={me} />
      <NameCard me={me} />
      <AboutCard me={me} />
      <AccountCard me={me} />
      <SecuritySection me={me} />
    </div>
  );
}

function NameCard({ me }: { me: View }) {
  const { t } = useT();
  const save = useSaveProfile();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ProfileForm>({
    resolver: zodResolver(profileSchema),
    defaultValues: { display_name: me.display_name ?? "" },
  });

  const onSubmit = handleSubmit(async ({ display_name }) => {
    try {
      await save({ display_name });
      toast.success(t("shell.profile.updated"));
    } catch (e) {
      if (!applyServerError(e, setError)) toast.error(messageFor(e));
    }
  });

  return (
    <SettingsGroup
      icon={UserRound}
      title={t("shell.profile.nameTitle")}
      description={t("shell.profile.nameDesc", { username: me.username })}
    >
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <Field
          id="display_name"
          label={t("shell.profile.nameTitle")}
          error={errors.display_name?.message}
        >
          <Input
            id="display_name"
            maxLength={32}
            aria-invalid={!!errors.display_name}
            aria-describedby={describedBy("display_name", errors.display_name?.message)}
            {...register("display_name")}
          />
        </Field>
        <Button type="submit" className="self-start" loading={isSubmitting}>
          {t("common.save")}
        </Button>
      </form>
    </SettingsGroup>
  );
}

function ReadOnly({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof AtSign;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <dt className="w-24 shrink-0 text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-sm font-medium">{value}</dd>
    </div>
  );
}

/** Dados que ainda não dá para editar: só leitura. */
function AccountCard({ me }: { me: View }) {
  const { t } = useT();
  return (
    <SettingsGroup
      icon={AtSign}
      title={t("shell.profile.accountTitle")}
      description={t("shell.profile.accountDesc")}
    >
      <dl className="flex flex-col gap-3">
        <ReadOnly
          icon={AtSign}
          label={t("shell.profile.usernameLabel")}
          value={`@${me.username}`}
        />
        <ReadOnly icon={Mail} label={t("common.email")} value={me.email} />
      </dl>
    </SettingsGroup>
  );
}

function AvatarCard({ me }: { me: View }) {
  const { t } = useT();
  const save = useSaveProfile();
  const requestUpload = useRequestAvatarUpload();
  const fileInput = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const name = me.display_name || me.username;
  const busy = progress !== null;

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
      await save({ avatar_key: key });
      toast.success(t("shell.profile.avatarUpdated"));
    } catch (e) {
      toast.error(
        e instanceof Error && !("status" in e) ? t("shell.profile.uploadFailed") : messageFor(e),
      );
    } finally {
      setProgress(null);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function remove() {
    try {
      await save({ remove_avatar: true });
      toast.success(t("shell.profile.avatarRemoved"));
    } catch (e) {
      toast.error(messageFor(e));
    }
  }

  return (
    <SettingsGroup
      icon={ImageIcon}
      title={t("shell.profile.avatarTitle")}
      description={t("shell.profile.avatarDesc")}
    >
      <div className="flex flex-wrap items-center gap-4">
        <Avatar url={me.avatar_url} name={name} size={80} />
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            <input
              ref={fileInput}
              id="avatar-file"
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="sr-only"
              onChange={(e) => void onFile(e.target.files?.[0])}
              disabled={busy}
            />
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
            >
              {busy ? t("shell.profile.uploading") : t("shell.profile.changeAvatar")}
            </Button>
            {me.avatar_url ? (
              <Button type="button" variant="ghost" disabled={busy} onClick={remove}>
                {t("shell.profile.remove")}
              </Button>
            ) : null}
          </div>
          {busy ? (
            <progress
              className="h-2 w-48 accent-primary"
              max={100}
              value={progress ?? 0}
              aria-label={t("shell.profile.progress")}
            />
          ) : null}
          {fileError ? (
            <p role="alert" className="text-xs text-destructive-text">
              {fileError}
            </p>
          ) : null}
        </div>
      </div>
    </SettingsGroup>
  );
}
