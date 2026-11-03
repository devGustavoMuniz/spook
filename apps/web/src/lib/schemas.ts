import { z } from "zod";

// Espelham as regras do contrato (server/api/openapi.yaml), com mensagens em pt-br.
export const emailSchema = z
  .string()
  .trim()
  .min(1, "Informe o e-mail.")
  .max(254)
  .pipe(z.email("E-mail inválido."));

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_.]{2,32}$/, "Use de 2 a 32 caracteres: letras minúsculas, números, _ e .");

export const passwordSchema = z
  .string()
  .min(8, "A senha precisa ter ao menos 8 caracteres.")
  .max(128, "A senha pode ter no máximo 128 caracteres.");

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Informe a senha.").max(128),
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
    message: "As senhas não coincidem.",
  });
export type ResetForm = z.infer<typeof resetSchema>;

export const chooseUsernameSchema = z.object({ username: usernameSchema });
export type ChooseUsernameForm = z.infer<typeof chooseUsernameSchema>;

export const setPasswordSchema = z
  .object({ new_password: passwordSchema, confirm: z.string() })
  .refine((v) => v.new_password === v.confirm, {
    path: ["confirm"],
    message: "As senhas não coincidem.",
  });
export type SetPasswordForm = z.infer<typeof setPasswordSchema>;

export const profileSchema = z.object({
  display_name: z.string().max(32, "No máximo 32 caracteres."),
});
export type ProfileForm = z.infer<typeof profileSchema>;

/** Avatar e banner: GIF e WebP animados são preservados pelo servidor. */
export const AVATAR_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

export function validateAvatar(file: File): string | null {
  if (!(AVATAR_TYPES as readonly string[]).includes(file.type))
    return "Use uma imagem PNG, JPEG, WebP ou GIF.";
  if (file.size > AVATAR_MAX_BYTES) return "A imagem pode ter no máximo 5 MB.";
  if (file.size === 0) return "O arquivo está vazio.";
  return null;
}

export const BIO_MAX = 190;
export const PRONOUNS_MAX = 40;

export const profileTextSchema = z.object({
  bio: z.string().max(BIO_MAX, `No máximo ${BIO_MAX} caracteres.`),
  pronouns: z.string().max(PRONOUNS_MAX, `No máximo ${PRONOUNS_MAX} caracteres.`),
});
export type ProfileTextForm = z.infer<typeof profileTextSchema>;

export const changePasswordSchema = z
  .object({
    current_password: z.string().min(1, "Informe a senha atual.").max(128),
    new_password: passwordSchema,
    confirm: z.string(),
  })
  .refine((v) => v.new_password === v.confirm, {
    path: ["confirm"],
    message: "As senhas não coincidem.",
  })
  .refine((v) => v.new_password !== v.current_password, {
    path: ["new_password"],
    message: "A nova senha deve ser diferente da atual.",
  });
export type ChangePasswordForm = z.infer<typeof changePasswordSchema>;

export const changeEmailSchema = z.object({ email: emailSchema });
export type ChangeEmailForm = z.infer<typeof changeEmailSchema>;

export const guildNameSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Use de 2 a 100 caracteres.")
    .max(100, "Use de 2 a 100 caracteres."),
});
export type GuildNameForm = z.infer<typeof guildNameSchema>;

export const channelFormSchema = z.object({
  name: z.string().trim().min(1, "Informe o nome.").max(100, "No máximo 100 caracteres."),
  type: z.enum(["0", "1", "2"]),
  parent_id: z.string(),
});
export type ChannelForm = z.infer<typeof channelFormSchema>;

/** Editar canal: nome e (em canais de texto) tópico de até 1024 caracteres. */
export const channelEditSchema = z.object({
  name: z.string().trim().min(1, "Informe o nome.").max(100, "No máximo 100 caracteres."),
  topic: z.string().max(1024, "No máximo 1024 caracteres."),
});
export type ChannelEditForm = z.infer<typeof channelEditSchema>;

/** Aceita o código puro ou o link completo (`.../invite/<código>`) e devolve só o código. */
export function parseInviteCode(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  const m = s.match(/(?:\/invite\/)?([A-Za-z0-9]+)\/?(?:[?#].*)?$/);
  return m?.[1] ?? null;
}
