import {
  Permission,
  useDisconnectVoiceMember,
  useGetMe,
  useMuteGuildMemberVoice,
  useUnmuteGuildMemberVoice,
  type VoiceStatePayload,
} from "@spook/shared";
import { useQueryClient } from "@tanstack/react-query";
import { MicOff, PhoneOff, ShieldOff } from "lucide-react";
import { toast } from "sonner";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useGuild } from "@/features/guilds/use-guild";
import { useGuildMembers } from "@/features/members/use-members";
import { appMessage } from "@/lib/app-errors";
import { can, canModerate } from "@/lib/guild";
import { queryKeys } from "@/lib/queryKeys";

/**
 * Moderação de voz de quem está num canal de servidor: mutar/liberar (MUTE_MEMBERS) e desconectar
 * (DISCONNECT_MEMBERS), respeitando a hierarquia como o servidor (que decide de verdade). Em DM ou sem
 * permissão, `canMute` e `canDisconnect` são falsos e nada aparece.
 */
export function useVoiceModeration(state: VoiceStatePayload) {
  const { data: me } = useGetMe();
  const guildId = state.guild_id ?? "";
  const { guild } = useGuild(guildId);
  const mayMuteBase = !!guild && can(guild, Permission.MUTE_MEMBERS);
  const mayDiscBase = !!guild && can(guild, Permission.DISCONNECT_MEMBERS);
  const members = useGuildMembers(guildId, !!guild && (mayMuteBase || mayDiscBase));
  const target = members.data?.members?.find((m) => m.user_id === state.user_id);
  const ready = !!guild && !!me && !!target;
  const canMute =
    ready && state.user_id !== me.id && canModerate(guild, Permission.MUTE_MEMBERS, target, me.id);
  const canDisconnect =
    ready &&
    state.user_id !== me.id &&
    canModerate(guild, Permission.DISCONNECT_MEMBERS, target, me.id);
  return { guildId, canMute, canDisconnect, any: canMute || canDisconnect, target };
}

/** Itens de menu "Mutar/Liberar o microfone" e "Desconectar" para quem tem permissão (nada, caso contrário). */
export function VoiceModerationItems({ state, name }: { state: VoiceStatePayload; name: string }) {
  const qc = useQueryClient();
  const mod = useVoiceModeration(state);
  const mute = useMuteGuildMemberVoice();
  const unmute = useUnmuteGuildMemberVoice();
  const disconnect = useDisconnectVoiceMember();
  if (!mod.any) return null;
  const muted = !!state.server_muted;

  async function toggleMute() {
    try {
      const vars = { guildId: mod.guildId, userId: state.user_id };
      if (muted) await unmute.mutateAsync(vars);
      else await mute.mutateAsync(vars);
      await qc.invalidateQueries({ queryKey: queryKeys.members(mod.guildId) });
      toast.success(muted ? `${name} pode falar de novo.` : `${name} foi mutado pelo servidor.`);
    } catch (e) {
      toast.error(appMessage(e));
    }
  }
  async function kickFromCall() {
    if (!state.channel_id) return;
    try {
      await disconnect.mutateAsync({ channelId: state.channel_id, userId: state.user_id });
      toast.success(`${name} foi desconectado da chamada.`);
    } catch (e) {
      toast.error(appMessage(e));
    }
  }
  return (
    <>
      {mod.canMute ? (
        <DropdownMenuItem onSelect={() => void toggleMute()}>
          {muted ? <ShieldOff /> : <MicOff />}
          {muted ? "Liberar o microfone" : "Mutar pelo servidor"}
        </DropdownMenuItem>
      ) : null}
      {mod.canDisconnect ? (
        <DropdownMenuItem destructive onSelect={() => void kickFromCall()}>
          <PhoneOff /> Desconectar da chamada
        </DropdownMenuItem>
      ) : null}
    </>
  );
}
