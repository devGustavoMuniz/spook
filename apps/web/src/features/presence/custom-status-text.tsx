import { useCustomStatus } from "./store";

/** Texto do status personalizado de alguém ("🎧 em foco"); nada se não houver. */
export function CustomStatusText({
  userId,
  className,
  prefix = "",
}: {
  userId: string | undefined;
  className?: string;
  prefix?: string;
}) {
  const custom = useCustomStatus(userId);
  if (!custom) return null;
  const label = `${custom.emoji ?? ""} ${custom.text ?? ""}`.trim();
  return (
    <span className={className} data-testid="custom-status" title={label}>
      {prefix}
      {label}
    </span>
  );
}
