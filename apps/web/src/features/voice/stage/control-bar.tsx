import { useListGuilds } from "@spook/shared";
import {
  HeadphoneOff,
  Headphones,
  LayoutGrid,
  Mic,
  MicOff,
  Monitor,
  MonitorOff,
  PhoneOff,
  RefreshCw,
  Settings,
  Video,
  VideoOff,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  leaveCall,
  screenSourceSwapSupported,
  swapScreenSource,
  toggleCamera,
  toggleDeafen,
  toggleMute,
  toggleScreenShare,
} from "../controller";
import { DeviceDialog } from "../device-dialog";
import { DeviceMenu } from "../device-menu";
import { voicePermissions } from "../permissions";
import { ScreenShareDialog } from "../screen-share-dialog";
import { useVoiceStore } from "../store";
import { LAYOUTS, useCallLayoutStore } from "./call-layout";
import { useStageHold } from "./use-auto-hide";

type Tone = "neutral" | "danger" | "brand";

function BarButton({
  label,
  shortcut,
  pressed,
  tone = "neutral",
  disabled,
  reason,
  onClick,
  children,
}: {
  label: string;
  shortcut?: string;
  pressed?: boolean;
  tone?: Tone;
  disabled?: boolean;
  /** Por que está desabilitado (permissão): vira dica e texto para leitores de tela. */
  reason?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  const button = (
    <Button
      variant="secondary"
      size="icon-lg"
      className={cn(
        "size-9 rounded-full bg-secondary text-foreground min-[420px]:size-11 sm:size-12",
        pressed &&
          tone === "danger" &&
          "bg-danger-soft text-destructive-text hover:bg-danger-soft hover:text-destructive-text",
        pressed &&
          tone === "brand" &&
          "bg-brand-500/25 text-brand-text hover:bg-brand-500/30 hover:text-brand-text",
      )}
      aria-label={label}
      aria-pressed={pressed}
      title={reason}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
      {reason ? <span className="sr-only"> ({reason})</span> : null}
    </Button>
  );
  if (disabled) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent className="flex items-center gap-2">
        {label}
        {shortcut ? (
          <Kbd className="border-background/30 bg-background/15 text-background">{shortcut}</Kbd>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}

/** Barra flutuante do palco: microfone, câmera, tela, dispositivos e sair (botão vermelho). */
export function ControlBar({ leaveLabel = "Sair do canal" }: { leaveLabel?: string }) {
  const s = useVoiceStore();
  const guilds = useListGuilds();
  const guild = s.guildId ? guilds.data?.find((g) => g.id === s.guildId) : null;
  const perms = voicePermissions(guild);
  const [shareDialog, setShareDialog] = useState(false);
  const [devices, setDevices] = useState(false);
  useStageHold(shareDialog || devices);
  const live = s.status === "connected";
  const micBlocked = !perms.speak;
  const videoReason = perms.video
    ? undefined
    : "Você não tem permissão para usar vídeo neste canal.";

  return (
    <>
      <div
        role="toolbar"
        aria-label="Controles do palco"
        className="flex items-center gap-1.5 rounded-full border border-border bg-card/85 p-1.5 shadow-lg backdrop-blur-md min-[420px]:gap-2 min-[420px]:p-2"
      >
        <DeviceMenu kind="audioinput">
          <BarButton
            label={s.selfMute ? "Ativar microfone" : "Silenciar microfone"}
            shortcut="M"
            pressed={s.selfMute}
            tone="danger"
            disabled={micBlocked || !live}
            reason={micBlocked ? "Você não tem permissão para falar neste canal." : undefined}
            onClick={() => void toggleMute()}
          >
            {s.selfMute ? <MicOff /> : <Mic />}
          </BarButton>
        </DeviceMenu>
        <DeviceMenu kind="audiooutput">
          <BarButton
            label={s.selfDeaf ? "Ativar áudio" : "Desativar áudio"}
            pressed={s.selfDeaf}
            tone="danger"
            disabled={!live}
            onClick={() => void toggleDeafen()}
          >
            {s.selfDeaf ? <HeadphoneOff /> : <Headphones />}
          </BarButton>
        </DeviceMenu>
        <BarButton
          label={s.camera ? "Desligar câmera" : "Ligar câmera"}
          shortcut="V"
          pressed={s.camera}
          tone="brand"
          disabled={!perms.video || !live}
          reason={videoReason}
          onClick={() => void toggleCamera()}
        >
          {s.camera ? <Video /> : <VideoOff />}
        </BarButton>
        <BarButton
          label={s.screen ? "Parar de compartilhar a tela" : "Compartilhar tela"}
          pressed={s.screen}
          tone="brand"
          disabled={!perms.video || !live}
          reason={videoReason}
          onClick={() => (s.screen ? void toggleScreenShare() : setShareDialog(true))}
        >
          {s.screen ? <Monitor /> : <MonitorOff />}
        </BarButton>
        {s.screen && screenSourceSwapSupported() ? (
          <BarButton label="Trocar janela/tela" onClick={() => void swapScreenSource()}>
            <RefreshCw />
          </BarButton>
        ) : null}
        <LayoutMenu />
        <BarButton label="Dispositivos" onClick={() => setDevices(true)}>
          <Settings />
        </BarButton>
        <span aria-hidden className="mx-0.5 h-6 w-px bg-border" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="destructive"
              size="icon-lg"
              className="size-11 rounded-full sm:size-12"
              aria-label={leaveLabel}
              onClick={() => void leaveCall()}
            >
              <PhoneOff />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{leaveLabel}</TooltipContent>
        </Tooltip>
      </div>
      <DeviceDialog open={devices} onOpenChange={setDevices} />
      <ScreenShareDialog
        open={shareDialog}
        onOpenChange={setShareDialog}
        onConfirm={(opts) => void toggleScreenShare(opts)}
      />
    </>
  );
}

/** Seletor de layout da chamada: grade, foco ou ocultar inativos (atalho L alterna). */
function LayoutMenu() {
  const layout = useCallLayoutStore((s) => s.layout);
  const set = useCallLayoutStore((s) => s.set);
  const [open, setOpen] = useState(false);
  useStageHold(open);
  const current = LAYOUTS.find((l) => l.id === layout);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="secondary"
              size="icon-lg"
              className="size-9 rounded-full bg-secondary text-foreground min-[420px]:size-11 sm:size-12"
              aria-label={`Layout da chamada: ${current?.label}`}
            >
              <LayoutGrid />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent className="flex items-center gap-2">
          Layout: {current?.label}
          <Kbd className="border-background/30 bg-background/15 text-background">L</Kbd>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent side="top" align="center" className="w-64">
        <DropdownMenuLabel>Layout da chamada</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={layout} onValueChange={(v) => set(v as typeof layout)}>
          {LAYOUTS.map((l) => (
            <DropdownMenuRadioItem key={l.id} value={l.id}>
              <span className="flex min-w-0 flex-col">
                <span>{l.label}</span>
                <span className="text-xs text-muted-foreground">{l.hint}</span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuShortcut className="px-2 py-1.5 text-left">
          Atalho: L alterna entre os layouts
        </DropdownMenuShortcut>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
