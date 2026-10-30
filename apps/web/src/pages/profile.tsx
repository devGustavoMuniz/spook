import { zodResolver } from "@hookform/resolvers/zod";
import {
  getGetMeQueryKey,
  useGetMe,
  useRequestAvatarUpload,
  useUpdateMe,
  type View,
} from "@spook/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { Avatar } from "@/components/avatar";
import { describedBy, Field } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { applyServerError, messageFor } from "@/lib/errors";
import { type ProfileForm, profileSchema, validateAvatar } from "@/lib/schemas";
import { putWithProgress } from "@/lib/upload";

export function ProfilePage() {
  const { data: me } = useGetMe();
  if (!me) return null;
  return (
    <div className="flex flex-col gap-6">
      <AvatarCard me={me} />
      <NameCard me={me} />
    </div>
  );
}

function useSaveProfile() {
  const qc = useQueryClient();
  const update = useUpdateMe();
  return async (data: { display_name?: string; avatar_key?: string; remove_avatar?: boolean }) => {
    const res = await update.mutateAsync({ data });
    qc.setQueryData(getGetMeQueryKey(), res);
    return res;
  };
}

function NameCard({ me }: { me: View }) {
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
      toast.success("Perfil atualizado.");
    } catch (e) {
      if (!applyServerError(e, setError)) toast.error(messageFor(e));
    }
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Nome de exibição</CardTitle>
        <CardDescription>
          Como você aparece para os outros. Deixe em branco para usar @{me.username}.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
          <Field id="display_name" label="Nome de exibição" error={errors.display_name?.message}>
            <Input
              id="display_name"
              maxLength={32}
              aria-invalid={!!errors.display_name}
              aria-describedby={describedBy("display_name", errors.display_name?.message)}
              {...register("display_name")}
            />
          </Field>
          <Button type="submit" className="self-start" disabled={isSubmitting}>
            {isSubmitting ? "Salvando…" : "Salvar"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function AvatarCard({ me }: { me: View }) {
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
          content_type: file.type as "image/png" | "image/jpeg" | "image/webp",
          size: file.size,
        },
      });
      await putWithProgress(upload_url, file, setProgress);
      await save({ avatar_key: key });
      toast.success("Avatar atualizado.");
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

  async function remove() {
    try {
      await save({ remove_avatar: true });
      toast.success("Avatar removido.");
    } catch (e) {
      toast.error(messageFor(e));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Avatar</CardTitle>
        <CardDescription>PNG, JPEG ou WebP, de até 5 MB.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-4">
        <Avatar url={me.avatar_url} name={name} size={80} />
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            <input
              ref={fileInput}
              id="avatar-file"
              type="file"
              accept="image/png,image/jpeg,image/webp"
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
              {busy ? "Enviando…" : "Trocar avatar"}
            </Button>
            {me.avatar_url ? (
              <Button type="button" variant="ghost" disabled={busy} onClick={remove}>
                Remover
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
      </CardContent>
    </Card>
  );
}
