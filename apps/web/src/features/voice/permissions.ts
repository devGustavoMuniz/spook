import { Permission } from "@spook/shared";
import { can, type Guild } from "@/lib/guild";

export type VoicePermissions = { connect: boolean; speak: boolean; video: boolean };

/** O que a UI deixa fazer. O servidor decide de verdade (o token só leva as origens permitidas). DM: tudo. */
export function voicePermissions(guild: Guild | null | undefined): VoicePermissions {
  if (!guild) return { connect: true, speak: true, video: true };
  return {
    connect: can(guild, Permission.CONNECT),
    speak: can(guild, Permission.SPEAK),
    video: can(guild, Permission.VIDEO),
  };
}
