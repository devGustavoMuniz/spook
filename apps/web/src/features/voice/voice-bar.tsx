import { useListGuilds } from "@spook/shared";
import { Link } from "@tanstack/react-router";
import {
  HeadphoneOff,
  Headphones,
  Mic,
  MicOff,
  Monitor,
  MonitorOff,
  PhoneOff,
  Settings,
  Video,
  VideoOff,
  Volume2,
} from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  leaveCall,
  resumeAudio,
  toggleCamera,
  toggleDeafen,
  toggleMute,
  toggleScreenShare,
} from "./controller";
import { DeviceDialog } from "./device-dialog";
import type { LinkQuality } from "./engine";
import { voicePermissions } from "./permissions";
import { ScreenShareDialog } from "./screen-share-dialog";
import { useVoiceStore } from "./store";

const qualityLabel: Record<LinkQuality, string> = {
  excellent: "Conexão excelente",
  good: "Conexão boa",
  poor: "Conexão ruim",
  lost: "Conexão perdida",
  unknown: "Conexão sem medição",
};
const qualityBars: Record<LinkQuality, number> = {
  excellent: 3,
  good: 3,
  poor: 2,
  lost: 1,
  unknown: 0,
};

/** Barras de sinal simples (a engine informa a qualidade do enlace). */
export function QualityIndicator({ quality }: { quality: LinkQuality }) {
  const bars = qualityBars[quality];
  return (
    <span
      role="img"
      aria-label={qualityLabel[quality]}
      title={qualityLabel[quality]}
      data-quality={quality}
      className="flex h-4 items-end gap-0.5"
    >
      {[1, 2, 3].map((n) => (
        <span
          key={n}
          style={{ height: `${n * 33}%` }}
          className={cn(
            "w-1 rounded-sm",
            n <= bars
              ? quality === "poor" || quality === "lost"
                ? "bg-warning"
                : "bg-success"
              : "bg-muted-foreground/30",
          )}
        />
      ))}
    </span>
  );
}

const statusText = {
  connecting: "Conectando…",
  connected: "Voz conectada",
  reconnecting: "Reconectando…",
  idle: "",
} as const;

/** Em chamada (conectando, conectada ou reconectando). */
export function useInCall() {
  return useVoiceStore((s) => s.status !== "idle" && !!s.channelId);
}

/** Permissões de voz do servidor da chamada atual (DM: tudo liberado). */
function useCallPermissions() {
  const guildId = useVoiceStore((s) => s.guildId);
  const guilds = useListGuilds();
  const guild = guildId ? guilds.data?.find((g) => g.id === guildId) : null;
  return voicePermissions(guild);
}

/**
 * Invólucro do rodapé da barra lateral: em chamada vira a região "Controles de voz"
 * (cartão + linha do usuário); fora dela é um bloco comum.
 */
export function VoiceDock({ children }: { children: React.ReactNode }) {
  const inCall = useInCall();
  return inCall ? (
    <section aria-label="Controles de voz" className="shrink-0 border-t bg-surface-2/60">
      {children}
    </section>
  ) : (
    <div className="shrink-0 border-t">{children}</div>
  );
}

/** Cartão "Voz conectada" acima do painel do usuário: canal, sair, câmera e tela. */
export function VoiceCallCard() {
  const s = useVoiceStore();
  const perms = useCallPermissions();
  const guilds = useListGuilds();
  const [shareDialog, setShareDialog] = useState(false);
  const [devices, setDevices] = useState(false);
  if (s.status === "idle" || !s.channelId) return null;

  const guild = s.guildId ? guilds.data?.find((g) => g.id === s.guildId) : null;
  const live = s.status === "connected";
  const videoBlocked = !perms.video;

  const linkClass = "truncate text-xs font-medium text-foreground hover:underline";
  const channelLink = s.guildId ? (
    <Link
      to="/channels/$guildId/$channelId"
      params={{ guildId: s.guildId, channelId: s.channelId }}
      className={linkClass}
    >
      {s.channelName}
    </Link>
  ) : (
    <Link to="/channels/@me/$channelId" params={{ channelId: s.channelId }} className={linkClass}>
      {s.channelName}
    </Link>
  );

  return (
    <div className="mx-2 mt-2 flex flex-col gap-2 rounded-xl border bg-card p-2.5 shadow-xs">
      <div className="flex items-center gap-2.5">
        <QualityIndicator quality={live ? s.quality : "unknown"} />
        <div className="flex min-w-0 flex-1 flex-col leading-tight">
          <output
            className={cn(
              "text-sm font-semibold",
              live ? "text-success-text" : "text-warning-text",
            )}
          >
            {statusText[s.status]}
          </output>
          {channelLink}
          {guild ? (
            <span className="truncate text-xs text-muted-foreground">{guild.name}</span>
          ) : null}
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="destructive"
              size="icon"
              className="size-8 shrink-0"
              aria-label="Sair da chamada"
              onClick={() => void leaveCall()}
            >
              <PhoneOff />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Sair da chamada</TooltipContent>
        </Tooltip>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {s.audioBlocked ? (
          <Button variant="outline" size="sm" onClick={() => void resumeAudio()}>
            <Volume2 /> Ativar áudio
          </Button>
        ) : null}
        <BarButton
          label={s.camera ? "Desligar câmera" : "Ligar câmera"}
          text="Câmera"
          pressed={s.camera}
          tone="brand"
          disabled={videoBlocked || !live}
          reason={videoBlocked ? "Você não tem permissão para usar vídeo neste canal." : undefined}
          onClick={() => void toggleCamera()}
        >
          {s.camera ? <Video /> : <VideoOff />}
        </BarButton>
        <BarButton
          label={s.screen ? "Parar de compartilhar a tela" : "Compartilhar tela"}
          text="Tela"
          pressed={s.screen}
          tone="brand"
          disabled={videoBlocked || !live}
          reason={videoBlocked ? "Você não tem permissão para usar vídeo neste canal." : undefined}
          onClick={() => (s.screen ? void toggleScreenShare() : setShareDialog(true))}
        >
          {s.screen ? <Monitor /> : <MonitorOff />}
        </BarButton>
        <BarButton label="Dispositivos" onClick={() => setDevices(true)}>
          <Settings />
        </BarButton>
      </div>
      <DeviceDialog open={devices} onOpenChange={setDevices} />
      <ScreenShareDialog
        open={shareDialog}
        onOpenChange={setShareDialog}
        onConfirm={(opts) => void toggleScreenShare(opts)}
      />
    </div>
  );
}

/**
 * Microfone, fone e (em chamada) dispositivos, na linha do usuário.
 * Fora da chamada só guardam a preferência, que vale na próxima entrada.
 */
export function VoiceUserControls() {
  const s = useVoiceStore();
  const perms = useCallPermissions();
  const inCall = s.status !== "idle" && !!s.channelId;
  const live = s.status === "connected";
  const micBlocked = inCall && !perms.speak;

  return (
    <>
      <BarButton
        label={s.selfMute ? "Ativar microfone" : "Silenciar microfone"}
        pressed={s.selfMute}
        tone="danger"
        disabled={micBlocked || (inCall && !live)}
        reason={micBlocked ? "Você não tem permissão para falar neste canal." : undefined}
        onClick={() => void toggleMute()}
      >
        {s.selfMute ? <MicOff /> : <Mic />}
      </BarButton>
      <BarButton
        label={s.selfDeaf ? "Ativar áudio" : "Desativar áudio"}
        pressed={s.selfDeaf}
        tone="danger"
        disabled={inCall && !live}
        onClick={() => void toggleDeafen()}
      >
        {s.selfDeaf ? <HeadphoneOff /> : <Headphones />}
      </BarButton>
    </>
  );
}

function BarButton({
  label,
  text,
  pressed,
  tone = "neutral",
  disabled,
  reason,
  onClick,
  children,
}: {
  label: string;
  /** Rótulo visível ao lado do ícone (botões do cartão da chamada). */
  text?: string;
  pressed?: boolean;
  /** `danger`: ligado = alerta (mudo/surdo); `brand`: ligado = em uso (câmera/tela). */
  tone?: "neutral" | "danger" | "brand";
  disabled?: boolean;
  /** Por que está desabilitado (permissão): aparece como dica. */
  reason?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const button = (
    <Button
      variant="ghost"
      size={text ? "sm" : "icon"}
      className={cn(
        "shrink-0 text-muted-foreground hover:text-foreground",
        text ? "h-8 flex-1 gap-1.5 bg-secondary/60" : "size-7",
        pressed &&
          (tone === "danger"
            ? "bg-danger-soft text-destructive-text hover:bg-danger-soft hover:text-destructive-text"
            : "bg-brand-500/20 text-brand-text hover:bg-brand-500/25 hover:text-brand-text"),
      )}
      aria-label={label}
      aria-pressed={pressed}
      title={reason}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
      {text ? <span aria-hidden>{text}</span> : null}
      {reason ? <span className="sr-only"> ({reason})</span> : null}
    </Button>
  );
  if (disabled) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
