import miniLogo from "@spook/brand/assets/mini-logo.svg";
import type * as React from "react";
import { cn } from "@/lib/utils";

export type PresenceStatus = "online" | "idle" | "dnd" | "invisible" | "offline";

/** Tamanhos nomeados (px). O `size` numérico continua valendo para casos pontuais. */
export const avatarSizes = { xs: 20, sm: 28, md: 40, lg: 64, xl: 96, "2xl": 128 } as const;
export type AvatarSize = keyof typeof avatarSizes | number;

const statusColor: Record<PresenceStatus, string> = {
  online: "bg-online",
  idle: "bg-idle",
  dnd: "bg-dnd",
  invisible: "bg-invisible",
  offline: "bg-offline",
};

/** Letras iniciais (até 2) de um nome de exibição ou username. */
export function initialsOf(name: string): string {
  const parts = name
    .trim()
    .replace(/^@/, "")
    .split(/[\s._-]+/)
    .filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0] as string;
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  return (first.charAt(0) + (parts[parts.length - 1] as string).charAt(0)).toUpperCase();
}

/**
 * Cor estável derivada do id (ou username): o mesmo usuário tem a mesma cor em todo lugar.
 * Matiz variável, saturação e luminosidade fixas: texto branco sempre passa de 4.5:1 (AA).
 */
export function avatarColor(seed: string): { from: string; to: string; hue: number } {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const hue = (h >>> 0) % 360;
  return {
    hue,
    from: `hsl(${hue} 46% 40%)`,
    to: `hsl(${(hue + 28) % 360} 52% 30%)`,
  };
}

/** Bolinha de status; o anel (`ring`) recorta o avatar com a cor da superfície onde ele está. */
export function StatusDot({
  status,
  size = 10,
  className,
  label,
}: {
  status: PresenceStatus;
  size?: number;
  className?: string;
  label?: string;
}) {
  return (
    <span
      role="img"
      aria-label={label ?? status}
      title={label}
      data-status={status}
      style={{ width: size, height: size }}
      className={cn(
        "inline-block rounded-full ring-2 ring-sidebar",
        statusColor[status],
        className,
      )}
    />
  );
}

/**
 * Avatar do usuário.
 * - sem imagem: `fallback="initials"` (padrão) mostra as iniciais sobre uma cor derivada do `seed` (id ou
 *   username); `fallback="logo"` usa a mini logo (só para casos de marca);
 * - `speaking` acende o anel verde de quem fala (voz);
 * - `status` põe a bolinha de presença no canto.
 */
export function Avatar({
  url,
  name,
  size = 64,
  className,
  fallback = "initials",
  seed,
  speaking = false,
  status,
  statusLabel,
  statusRingClassName,
}: {
  url?: string;
  name: string;
  size?: AvatarSize;
  className?: string;
  fallback?: "logo" | "initials";
  seed?: string;
  speaking?: boolean;
  status?: PresenceStatus;
  statusLabel?: string;
  statusRingClassName?: string;
}) {
  const px = typeof size === "number" ? size : avatarSizes[size];
  const label = `Avatar de ${name}`;
  const box: React.CSSProperties = { width: px, height: px };

  const wrapped = speaking || Boolean(status);
  const faceClass = wrapped ? undefined : className;
  let face: React.ReactNode;
  if (url || fallback === "logo") {
    face = (
      <img
        src={url || miniLogo}
        alt={label}
        width={px}
        height={px}
        style={box}
        className={cn("rounded-full bg-muted object-cover", faceClass)}
      />
    );
  } else {
    const c = avatarColor(seed ?? name);
    face = (
      <span
        role="img"
        aria-label={label}
        data-initials={initialsOf(name)}
        style={{
          ...box,
          fontSize: Math.max(9, Math.round(px * 0.38)),
          background: `linear-gradient(135deg, ${c.from}, ${c.to})`,
        }}
        className={cn(
          // As iniciais vêm do CSS (attr): não entram no texto da página (leitor de tela, busca, cópia).
          "inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white select-none before:content-[attr(data-initials)]",
          faceClass,
        )}
      />
    );
  }

  if (!wrapped) return face;
  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 rounded-full transition-shadow duration-[var(--dur-base)]",
        speaking && "shadow-speaking",
        className,
      )}
      style={box}
      data-speaking={speaking || undefined}
    >
      {face}
      {status ? (
        <StatusDot
          status={status}
          label={statusLabel}
          size={Math.max(8, Math.round(px / 3.2))}
          className={cn("absolute -right-0.5 -bottom-0.5", statusRingClassName)}
        />
      ) : null}
    </span>
  );
}
