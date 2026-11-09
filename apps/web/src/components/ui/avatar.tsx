import * as React from "react";
import { LogoMark } from "@/components/brand";
import { canAnimateAvatar, type PlanTier } from "@/features/nitro/plans";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import {
  isGifUrl,
  loadStaticFrame,
  paintCover,
  peekStaticFrame,
  type StaticFrame,
} from "./static-frame";

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
 * Quando um avatar GIF anima:
 * - `never` (padrão): sempre parado no primeiro quadro (lista de membros, mensagens, DMs, painel do usuário...);
 * - `speaking`: parado, e anima enquanto `animating` (padrão: `speaking`) for verdadeiro: usado só dentro de uma
 *   chamada de voz, com o mesmo sinal de fala que acende o anel verde;
 * - `always`: sempre animado (perfil ampliado).
 * `prefers-reduced-motion` vence qualquer valor: nunca anima. Não-GIF ignora a prop (sem custo extra).
 */
export type AvatarAnimation = "never" | "always" | "speaking";

function usePrefersReducedMotion(enabled: boolean): boolean {
  const query = "(prefers-reduced-motion: reduce)";
  const subscribe = React.useCallback(
    (cb: () => void) => {
      if (!enabled || typeof window.matchMedia !== "function") return () => {};
      const mql = window.matchMedia(query);
      mql.addEventListener("change", cb);
      return () => mql.removeEventListener("change", cb);
    },
    [enabled],
  );
  const get = () =>
    enabled && typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false;
  return React.useSyncExternalStore(subscribe, get, () => false);
}

/** Rosto de avatar GIF: primeiro quadro no canvas e, se couber, o GIF de verdade por cima enquanto anima. */
function GifFace({
  url,
  px,
  label,
  animation,
  animating,
  className,
  placeholder,
}: {
  url: string;
  px: number;
  label: string;
  animation: AvatarAnimation;
  animating: boolean;
  className?: string;
  placeholder: React.ReactNode;
}) {
  const reduced = usePrefersReducedMotion(true);
  const mode: AvatarAnimation = reduced ? "never" : animation;
  const box: React.CSSProperties = { width: px, height: px };
  if (mode === "always") {
    return (
      <img
        src={url}
        alt={label}
        width={px}
        height={px}
        style={box}
        className={cn("rounded-full bg-muted object-cover", className)}
      />
    );
  }
  return (
    <StillGif
      url={url}
      px={px}
      label={label}
      play={mode === "speaking" && animating}
      className={className}
      placeholder={placeholder}
    />
  );
}

function StillGif({
  url,
  px,
  label,
  play,
  className,
  placeholder,
}: {
  url: string;
  px: number;
  label: string;
  play: boolean;
  className?: string;
  placeholder: React.ReactNode;
}) {
  const [frame, setFrame] = React.useState<StaticFrame | null | undefined>(() =>
    peekStaticFrame(url),
  );
  const [failed, setFailed] = React.useState(false);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const [live, setLive] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    setFailed(false);
    const hit = peekStaticFrame(url);
    if (hit) {
      setFrame(hit);
      return;
    }
    setFrame(undefined);
    void loadStaticFrame(url).then((f) => {
      if (!alive) return;
      if (f) setFrame(f);
      else setFailed(true);
    });
    return () => {
      alive = false;
    };
  }, [url]);

  const dpr = typeof window === "undefined" ? 1 : Math.min(2, window.devicePixelRatio || 1);
  const side = Math.max(1, Math.round(px * dpr));
  // biome-ignore lint/correctness/useExhaustiveDependencies: mudar o tamanho (`side`) limpa o canvas: repinta.
  React.useLayoutEffect(() => {
    if (frame && canvasRef.current) paintCover(canvasRef.current, frame);
  }, [frame, side]);

  // Ao parar de falar o GIF sai; na próxima fala ele reaparece com fade (o canvas por baixo evita piscar).
  React.useEffect(() => {
    if (!play) setLive(false);
  }, [play]);

  if (failed || !frame) return <>{placeholder}</>;
  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 overflow-hidden rounded-full bg-muted",
        className,
      )}
      style={{ width: px, height: px }}
      data-gif-still
    >
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={label}
        width={side}
        height={side}
        style={{ width: px, height: px }}
        className="rounded-full"
      />
      {play ? (
        <img
          src={url}
          alt=""
          aria-hidden
          width={px}
          height={px}
          data-gif-live
          style={{ width: px, height: px }}
          onLoad={() => setLive(true)}
          className={cn(
            "absolute inset-0 rounded-full object-cover transition-opacity duration-[var(--dur-base)]",
            live ? "opacity-100" : "opacity-0",
          )}
        />
      ) : null}
    </span>
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
  animation = "never",
  animating,
  plan,
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
  /** GIF animado: ver `AvatarAnimation`. Padrão `never` (parado). */
  animation?: AvatarAnimation;
  /** Com `animation="speaking"`: anima enquanto verdadeiro (padrão: o valor de `speaking`). */
  animating?: boolean;
  /**
   * Plano do DONO da imagem (não de quem vê). Só quem tem Nitro/Nitro+ anima: sem plano o GIF fica sempre parado
   * (primeiro quadro), qualquer que seja `animation`. Ausente (`undefined`) = sem restrição, para imagens que não
   * são de uma pessoa (ícone de servidor); para pessoas passe `plan ?? "free"`.
   */
  plan?: PlanTier;
  status?: PresenceStatus;
  statusLabel?: string;
  statusRingClassName?: string;
}) {
  const px = typeof size === "number" ? size : avatarSizes[size];
  const { t } = useT();
  const label = t("shell.avatar.of", { name });
  const box: React.CSSProperties = { width: px, height: px };

  const mode: AvatarAnimation = plan === undefined || canAnimateAvatar(plan) ? animation : "never";
  const wrapped = speaking || Boolean(status);
  const faceClass = wrapped ? undefined : className;
  let face: React.ReactNode;
  const initialsFace = () => {
    const c = avatarColor(seed ?? name);
    return (
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
  };
  if (!url && fallback === "logo") {
    // Marca com fundo transparente dentro de um círculo do tema, com respiro uniforme.
    face = (
      <span
        role="img"
        aria-label={label}
        style={box}
        className={cn(
          "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-surface-3",
          faceClass,
        )}
      >
        <LogoMark size={Math.round(px * 0.8)} alt="" />
      </span>
    );
  } else if (url) {
    const initials = initialsFace();
    face = isGifUrl(url) ? (
      <GifFace
        url={url}
        px={px}
        label={label}
        animation={mode}
        animating={animating ?? speaking}
        className={faceClass}
        placeholder={initials}
      />
    ) : (
      <img
        src={url}
        alt={label}
        width={px}
        height={px}
        style={box}
        className={cn("rounded-full bg-muted object-cover", faceClass)}
      />
    );
  } else {
    face = initialsFace();
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
