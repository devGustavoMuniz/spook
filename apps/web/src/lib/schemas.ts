import { z } from "zod";
import { t } from "@/i18n";

// Espelham as regras do contrato (server/api/openapi.yaml), com mensagens em pt-br.
export const emailSchema = z
  .string()
  .trim()
  .min(1, { error: () => t("auth.validation.emailRequired") })
  .max(254)
  .pipe(z.email({ error: () => t("auth.validation.emailInvalid") }));

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_.]{2,32}$/, { error: () => t("auth.validation.usernameFormat") });

export const passwordSchema = z
  .string()
  .min(8, { error: () => t("auth.validation.passwordMin") })
  .max(128, { error: () => t("auth.validation.passwordMax") });

export const loginSchema = z.object({
  email: emailSchema,
  password: z
    .string()
    .min(1, { error: () => t("auth.validation.passwordRequired") })
    .max(128),
});
export type LoginForm = z.infer<typeof loginSchema>;

export const registerSchema = z.object({
  email: emailSchema,
  username: usernameSchema,
  password: passwordSchema,
});
export type RegisterForm = z.infer<typeof registerSchema>;

export const forgotSchema = z.object({ email: emailSchema });
export type ForgotForm = z.infer<typeof forgotSchema>;

export const resetSchema = z
  .object({ new_password: passwordSchema, confirm: z.string() })
  .refine((v) => v.new_password === v.confirm, {
    path: ["confirm"],
    error: () => t("auth.validation.passwordMismatch"),
  });
export type ResetForm = z.infer<typeof resetSchema>;

export const chooseUsernameSchema = z.object({ username: usernameSchema });
export type ChooseUsernameForm = z.infer<typeof chooseUsernameSchema>;

export const setPasswordSchema = z
  .object({ new_password: passwordSchema, confirm: z.string() })
  .refine((v) => v.new_password === v.confirm, {
    path: ["confirm"],
    error: () => t("auth.validation.passwordMismatch"),
  });
export type SetPasswordForm = z.infer<typeof setPasswordSchema>;

export const profileSchema = z.object({
  display_name: z.string().max(32, { error: () => t("auth.validation.maxChars", { max: 32 }) }),
});
export type ProfileForm = z.infer<typeof profileSchema>;

/** Avatar e banner: GIF e WebP animados são preservados pelo servidor. */
export const AVATAR_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

export function validateAvatar(file: File): string | null {
  if (!(AVATAR_TYPES as readonly string[]).includes(file.type))
    return t("auth.validation.avatarType");
  if (file.size > AVATAR_MAX_BYTES) return t("auth.validation.avatarSize");
  if (file.size === 0) return t("auth.validation.fileEmpty");
  return null;
}

export const BIO_MAX = 190;
export const PRONOUNS_MAX = 40;

export const profileTextSchema = z.object({
  bio: z.string().max(BIO_MAX, { error: () => t("auth.validation.maxChars", { max: BIO_MAX }) }),
  pronouns: z
    .string()
    .max(PRONOUNS_MAX, { error: () => t("auth.validation.maxChars", { max: PRONOUNS_MAX }) }),
});
export type ProfileTextForm = z.infer<typeof profileTextSchema>;

export const changePasswordSchema = z
  .object({
    current_password: z
      .string()
      .min(1, { error: () => t("auth.validation.currentPasswordRequired") })
      .max(128),
    new_password: passwordSchema,
    confirm: z.string(),
  })
  .refine((v) => v.new_password === v.confirm, {
    path: ["confirm"],
    error: () => t("auth.validation.passwordMismatch"),
  })
  .refine((v) => v.new_password !== v.current_password, {
    path: ["new_password"],
    error: () => t("auth.validation.newPasswordSame"),
  });
export type ChangePasswordForm = z.infer<typeof changePasswordSchema>;

export const changeEmailSchema = z.object({ email: emailSchema });
export type ChangeEmailForm = z.infer<typeof changeEmailSchema>;

export const guildNameSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, { error: () => t("auth.validation.nameLength") })
    .max(100, { error: () => t("auth.validation.nameLength") }),
});
export type GuildNameForm = z.infer<typeof guildNameSchema>;

export const channelFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, { error: () => t("auth.validation.nameRequired") })
    .max(100, { error: () => t("auth.validation.maxChars", { max: 100 }) }),
  type: z.enum(["0", "1", "2"]),
  parent_id: z.string(),
});
export type ChannelForm = z.infer<typeof channelFormSchema>;

/** Editar canal: nome e (em canais de texto) tópico de até 1024 caracteres. */
export const channelEditSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, { error: () => t("auth.validation.nameRequired") })
    .max(100, { error: () => t("auth.validation.maxChars", { max: 100 }) }),
  topic: z.string().max(1024, { error: () => t("auth.validation.maxChars", { max: 1024 }) }),
});
export type ChannelEditForm = z.infer<typeof channelEditSchema>;

/** Aceita o código puro ou o link completo (`.../invite/<código>`) e devolve só o código. */
export function parseInviteCode(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  const m = s.match(/(?:\/invite\/)?([A-Za-z0-9]+)\/?(?:[?#].*)?$/);
  return m?.[1] ?? null;
}
