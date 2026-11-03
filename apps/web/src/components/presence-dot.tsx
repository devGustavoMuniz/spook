import { Avatar, StatusDot } from "@/components/ui/avatar";
import { type DisplayStatus, usePresence } from "@/features/presence/store";
import { type MessageKey, t, useT } from "@/i18n";
import { cn } from "@/lib/utils";

const statusKey = {
  online: "shell.status.online",
  idle: "shell.status.idle",
  dnd: "shell.status.dnd",
  invisible: "shell.status.invisible",
  offline: "shell.status.offline",
} as const satisfies Record<DisplayStatus, MessageKey>;

/** Rótulo de status no idioma ativo (lido a cada acesso). Em componentes prefira `useStatusLabel()`. */
export const statusLabel: Record<DisplayStatus, string> = {
  get online() {
    return t(statusKey.online);
  },
  get idle() {
    return t(statusKey.idle);
  },
  get dnd() {
    return t(statusKey.dnd);
  },
  get invisible() {
    return t(statusKey.invisible);
  },
  get offline() {
    return t(statusKey.offline);
  },
};

/** Hook: devolve o rótulo de um status e re-renderiza quando o idioma muda. */
export function useStatusLabel(): (status: DisplayStatus) => string {
  const { t: tt } = useT();
  return (status) => tt(statusKey[status]);
}

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
  const label = useStatusLabel();
  return <StatusDot status={status} label={label(status)} size={size} className={className} />;
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
      <Avatar url={url} name={name} size={size} seed={userId} />
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
