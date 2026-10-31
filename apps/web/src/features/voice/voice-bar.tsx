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

/** Barra persistente enquanto o usuário está em uma chamada: canal, mudo, surdo, câmera, tela e sair. */
export function VoiceBar() {
  const s = useVoiceStore();
  const guilds = useListGuilds();
  const [devices, setDevices] = useState(false);
  const [shareDialog, setShareDialog] = useState(false);
  if (s.status === "idle" || !s.channelId) return null;

  const guild = s.guildId ? guilds.data?.find((g) => g.id === s.guildId) : null;
  const perms = voicePermissions(guild);
  const live = s.status === "connected";
  const micBlocked = !perms.speak;
  const videoBlocked = !perms.video;

  const channelLink = s.guildId ? (
    <Link
      to="/channels/$guildId/$channelId"
      params={{ guildId: s.guildId, channelId: s.channelId }}
      className="truncate text-xs text-muted-foreground hover:underline"
    >
      {s.channelName}
    </Link>
  ) : (
    <Link
      to="/channels/@me/$channelId"
      params={{ channelId: s.channelId }}
      className="truncate text-xs text-muted-foreground hover:underline"
    >
      {s.channelName}
    </Link>
  );

  return (
    <section
      aria-label="Controles de voz"
      className="flex shrink-0 flex-wrap items-center gap-3 border-t bg-sidebar px-3 py-2"
    >
      <div className="flex min-w-0 items-center gap-2">
        <QualityIndicator quality={live ? s.quality : "unknown"} />
        <div className="flex min-w-0 flex-col leading-tight">
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
        </div>
      </div>

      <div className="ml-auto flex items-center gap-1">
        {s.audioBlocked ? (
          <Button variant="outline" size="sm" onClick={() => void resumeAudio()}>
            <Volume2 /> Ativar áudio
          </Button>
        ) : null}
        <BarButton
          label={s.selfMute ? "Ativar microfone" : "Silenciar microfone"}
          pressed={s.selfMute}
          disabled={micBlocked || !live}
          reason={micBlocked ? "Você não tem permissão para falar neste canal." : undefined}
          onClick={() => void toggleMute()}
        >
          {s.selfMute ? <MicOff /> : <Mic />}
        </BarButton>
        <BarButton
          label={s.selfDeaf ? "Ativar áudio" : "Desativar áudio"}
          pressed={s.selfDeaf}
          disabled={!live}
          onClick={() => void toggleDeafen()}
        >
          {s.selfDeaf ? <HeadphoneOff /> : <Headphones />}
        </BarButton>
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
        <BarButton label="Dispositivos" onClick={() => setDevices(true)}>
          <Settings />
        </BarButton>
        <Button
          variant="destructive"
          size="icon"
          aria-label="Sair da chamada"
          title="Sair da chamada"
          onClick={() => void leaveCall()}
        >
          <PhoneOff />
        </Button>
      </div>
      <DeviceDialog open={devices} onOpenChange={setDevices} />
      <ScreenShareDialog
        open={shareDialog}
        onOpenChange={setShareDialog}
        onConfirm={(opts) => void toggleScreenShare(opts)}
      />
    </section>
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
