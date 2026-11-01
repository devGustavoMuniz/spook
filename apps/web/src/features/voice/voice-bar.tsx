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
                ? "bg-amber-500"
                : "bg-emerald-500"
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
    <section aria-label="Controles de voz" className="shrink-0 border-t bg-sidebar">
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
  if (s.status === "idle" || !s.channelId) return null;

  const guild = s.guildId ? guilds.data?.find((g) => g.id === s.guildId) : null;
  const live = s.status === "connected";
  const videoBlocked = !perms.video;

  const linkClass = "truncate text-xs text-muted-foreground hover:underline";
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
    <div className="mx-2 mt-2 flex flex-col gap-1 rounded-md bg-muted/50 p-2">
      <div className="flex items-center gap-2">
        <QualityIndicator quality={live ? s.quality : "unknown"} />
        <div className="flex min-w-0 flex-1 flex-col leading-tight">
          <output
            className={cn(
              "text-sm font-medium",
              live
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-amber-600 dark:text-amber-400",
            )}
          >
            {statusText[s.status]}
          </output>
          {channelLink}
          {guild ? (
            <span className="truncate text-xs text-muted-foreground">{guild.name}</span>
          ) : null}
        </div>
        <Button
          variant="destructive"
          size="icon"
          className="size-8 shrink-0"
          aria-label="Sair da chamada"
          title="Sair da chamada"
          onClick={() => void leaveCall()}
        >
          <PhoneOff />
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {s.audioBlocked ? (
          <Button variant="outline" size="sm" onClick={() => void resumeAudio()}>
            <Volume2 /> Ativar áudio
          </Button>
        ) : null}
        <BarButton
          label={s.camera ? "Desligar câmera" : "Ligar câmera"}
          pressed={s.camera}
          disabled={videoBlocked || !live}
          reason={videoBlocked ? "Você não tem permissão para usar vídeo neste canal." : undefined}
          onClick={() => void toggleCamera()}
        >
          {s.camera ? <Video /> : <VideoOff />}
        </BarButton>
        <BarButton
          label={s.screen ? "Parar de compartilhar a tela" : "Compartilhar tela"}
          pressed={s.screen}
          disabled={videoBlocked || !live}
          reason={videoBlocked ? "Você não tem permissão para usar vídeo neste canal." : undefined}
          onClick={() => (s.screen ? void toggleScreenShare() : setShareDialog(true))}
        >
          {s.screen ? <Monitor /> : <MonitorOff />}
        </BarButton>
      </div>
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
  const [devices, setDevices] = useState(false);
  const inCall = s.status !== "idle" && !!s.channelId;
  const live = s.status === "connected";
  const micBlocked = inCall && !perms.speak;

  return (
    <>
      <BarButton
        label={s.selfMute ? "Ativar microfone" : "Silenciar microfone"}
        pressed={s.selfMute}
        disabled={micBlocked || (inCall && !live)}
        reason={micBlocked ? "Você não tem permissão para falar neste canal." : undefined}
        onClick={() => void toggleMute()}
      >
        {s.selfMute ? <MicOff /> : <Mic />}
      </BarButton>
      <BarButton
        label={s.selfDeaf ? "Ativar áudio" : "Desativar áudio"}
        pressed={s.selfDeaf}
        disabled={inCall && !live}
        onClick={() => void toggleDeafen()}
      >
        {s.selfDeaf ? <HeadphoneOff /> : <Headphones />}
      </BarButton>
      {inCall ? (
        <>
          <BarButton label="Dispositivos" onClick={() => setDevices(true)}>
            <Settings />
          </BarButton>
          <DeviceDialog open={devices} onOpenChange={setDevices} />
        </>
      ) : null}
    </>
  );
}

function BarButton({
  label,
  pressed,
  disabled,
  reason,
  onClick,
  children,
}: {
  label: string;
  pressed?: boolean;
  disabled?: boolean;
  /** Por que está desabilitado (permissão): aparece como dica. */
  reason?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      variant={pressed ? "secondary" : "ghost"}
      size="icon"
      className="size-8 shrink-0"
      aria-label={label}
      aria-pressed={pressed}
      title={reason ?? label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
      {reason ? <span className="sr-only"> ({reason})</span> : null}
    </Button>
  );
}
