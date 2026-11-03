import { useShallow } from "zustand/react/shallow";
import { formatBadge, t, useT } from "@/i18n";
import { cn } from "@/lib/utils";
import {
  allMentions,
  type ChannelRead,
  dmTotals,
  guildTotals,
  type Totals,
  useReadStateStore,
} from "./read-state";

/** "1 menção em #geral" / "3 menções em #geral" (99+ acima de 99). */
export const mentionLabel = (count: number, where: string) =>
  t("settings.badges.mentionsIn", { count, shown: formatBadge(count), where });

/** Contador vermelho de menções ("99+" acima de 99). `label` é o texto para leitores de tela. */
export function MentionBadge({
  count,
  label,
  className,
}: {
  count: number;
  label?: string;
  className?: string;
}) {
  const { t } = useT();
  if (count <= 0) return null;
  return (
    <span
      role="img"
      aria-label={label ?? t("settings.badges.mentions", { count, shown: formatBadge(count) })}
      className={cn(
        "inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] leading-none font-bold text-destructive-foreground tabular-nums",
        className,
      )}
    >
      <span aria-hidden>{formatBadge(count)}</span>
    </span>
  );
}

/** Ponto de "tem mensagens novas" (sem número). */
export function UnreadDot({ label, className }: { label: string; className?: string }) {
  return (
    <span
      role="img"
      aria-label={label}
      className={cn("size-2 shrink-0 rounded-full bg-primary", className)}
    />
  );
}

export const useChannelRead = (channelId: string): ChannelRead | undefined =>
  useReadStateStore((s) => s.channels[channelId]);

export const useGuildTotals = (guildId: string): Totals =>
  useReadStateStore(useShallow((s) => guildTotals(s.channels, guildId)));

export const useDmTotals = () => useReadStateStore(useShallow((s) => dmTotals(s.channels)));

export const useTotalMentions = () => useReadStateStore((s) => allMentions(s.channels));
