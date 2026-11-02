import { Avatar, StatusDot } from "@/components/ui/avatar";
import { type DisplayStatus, usePresence } from "@/features/presence/store";
import { cn } from "@/lib/utils";

export const statusLabel: Record<DisplayStatus, string> = {
  online: "Online",
  idle: "Ausente",
  dnd: "Não perturbar",
  invisible: "Invisível",
  offline: "Offline",
};

/** Bolinha de status (online / ausente / offline), com texto para leitores de tela. */
export function PresenceDot({
  status,
  size = 10,
  className,
}: {
  status: DisplayStatus;
  size?: number;
  className?: string;
}) {
  return (
    <StatusDot status={status} label={statusLabel[status]} size={size} className={className} />
  );
}

/** Avatar com a bolinha de status no canto inferior direito. */
export function StatusAvatar({
  userId,
  url,
  name,
  size = 28,
  className,
}: {
  userId: string | undefined;
  url?: string;
  name: string;
  size?: number;
  className?: string;
}) {
  const status = usePresence(userId);
  return (
    <span
      className={cn("relative inline-flex shrink-0", className)}
      style={{ width: size, height: size }}
    >
      <Avatar url={url} name={name} size={size} />
      {userId ? (
        <PresenceDot
          status={status}
          size={Math.max(8, Math.round(size / 3.2))}
          className="absolute -right-0.5 -bottom-0.5"
        />
      ) : null}
    </span>
  );
}
