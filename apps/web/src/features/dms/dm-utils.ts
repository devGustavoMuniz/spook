import type { ChannelPayload, RecipientPayload } from "@spook/shared";
import { shownName } from "@/features/account/removed-user";
import { t } from "@/i18n";
import { CHANNEL_GROUP_DM } from "@/lib/dm-cache";

export const recipientName = (r: RecipientPayload) => shownName(r.display_name, r.username);
export const recipientsOf = (c: ChannelPayload): RecipientPayload[] => c.recipients ?? [];
export const isGroupDm = (c: ChannelPayload) => c.type === CHANNEL_GROUP_DM;
export const isDmOwner = (c: ChannelPayload, myId: string) => isGroupDm(c) && c.owner_id === myId;

/** O outro participante de uma DM 1:1 (undefined num grupo). */
export function otherRecipient(c: ChannelPayload, myId: string): RecipientPayload | undefined {
  if (isGroupDm(c)) return undefined;
  return recipientsOf(c).find((r) => r.id !== myId);
}

/** 1:1: nome do outro; grupo: o nome dado ou os nomes dos demais participantes. */
export function dmTitle(c: ChannelPayload, myId: string): string {
  if (!isGroupDm(c)) {
    const other = otherRecipient(c, myId);
    return other ? recipientName(other) : t("people.dm.fallbackDm");
  }
  if (c.name) return c.name;
  const others = recipientsOf(c)
    .filter((r) => r.id !== myId)
    .map(recipientName);
  return others.length > 0 ? others.join(", ") : t("people.dm.fallbackGroup");
}
