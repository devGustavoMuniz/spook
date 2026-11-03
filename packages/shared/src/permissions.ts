// Bitflags de permissão (SPEC 7.2). Espelha server/internal/perm; a regra de verdade é do servidor,
// aqui serve só para mostrar/esconder ações na interface.

export const Permission = {
  ADMINISTRATOR: 1 << 0,
  MANAGE_GUILD: 1 << 1,
  MANAGE_CHANNELS: 1 << 2,
  MANAGE_ROLES: 1 << 3,
  KICK_MEMBERS: 1 << 4,
  CREATE_INVITE: 1 << 5,
  VIEW_CHANNEL: 1 << 6,
  SEND_MESSAGES: 1 << 7,
  MANAGE_MESSAGES: 1 << 8,
  ATTACH_FILES: 1 << 9,
  CONNECT: 1 << 10,
  SPEAK: 1 << 11,
  VIDEO: 1 << 12,
  // Moderação (adicional).
  BAN_MEMBERS: 1 << 13,
  CHANGE_NICKNAME: 1 << 14,
  MANAGE_NICKNAMES: 1 << 15,
  MUTE_MEMBERS: 1 << 16,
  DISCONNECT_MEMBERS: 1 << 17,
  VIEW_AUDIT_LOG: 1 << 18,
} as const;

/** Permissões que um canal pode permitir ou negar (overwrites); as demais valem só no servidor inteiro. */
export const CHANNEL_SCOPED_PERMISSIONS = [
  "VIEW_CHANNEL",
  "SEND_MESSAGES",
  "MANAGE_MESSAGES",
  "ATTACH_FILES",
  "CONNECT",
  "SPEAK",
  "VIDEO",
] as const;

export type PermissionName = keyof typeof Permission;
export type PermissionFlag = (typeof Permission)[PermissionName];

/** Todas as permissões definidas. */
export const ALL_PERMISSIONS: number = Object.values(Permission).reduce((a, b) => a | b, 0);

/**
 * Verifica se `effective` inclui `flag`. O dono e quem tem ADMINISTRATOR têm tudo. O servidor já
 * devolve a permissão efetiva do usuário; `isOwner` cobre o caso de o dono nunca depender de bits.
 */
export function hasPermission(
  effective: number,
  flag: PermissionFlag,
  options: { isOwner?: boolean } = {},
): boolean {
  if (options.isOwner) return true;
  if ((effective & Permission.ADMINISTRATOR) !== 0) return true;
  return (effective & flag) === flag;
}
