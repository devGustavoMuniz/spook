import type { VoiceStatePayload } from "@spook/shared";
import {
  Expand,
  EyeOff,
  HeadphoneOff,
  Maximize2,
  MicOff,
  Minimize2,
  Monitor,
  MonitorUp,
  MoreHorizontal,
  PictureInPicture2,
  RefreshCw,
  ShieldOff,
  Video,
  Volume2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import { audioCapabilities, participantVolumeMax } from "../controller";
import { loadViewStreamPreviews } from "../devices";
import type { VideoTrackInfo } from "../engine";
import { useVoiceModeration, VoiceModerationItems } from "../moderation";
import { PersonVolumePanel } from "../person-volume";
import { togglePictureInPicture, usePictureInPictureId } from "../pip";
import { useStreamPreview } from "../screen-preview";
import { useVoiceStatesStore } from "../store";
import type { PersonLookup } from "../use-person-lookup";
import { ViewersBadge } from "../viewers";
import { useTileColor } from "./dominant-color";
import { useStageHold } from "./use-auto-hide";

export type TileModel = {
  /** Chave estável: `u:<id>` (pessoa) ou `s:<trackId>` (tela). */
  key: string;
  userId: string;
  name: string;
  avatarUrl?: string;
  /** `person`: avatar (ou câmera) da pessoa; `screen`: tela compartilhada. */
  kind: "person" | "screen";
  local: boolean;
  video?: VideoTrackInfo;
  state?: VoiceStatePayload;
  /**
   * Tela de outra pessoa que ainda NÃO assisto (sem faixa assinada): mostra a prévia e o botão "Assistir".
   * Só existe quando a engine deixa escolher (`audioCapabilities.screenWatch`).
   */
  unwatched?: boolean;
  /** Tela de outra pessoa que posso parar de assistir (a engine deixa escolher). */
  canStopWatching?: boolean;
  /** Minha tela e a engine troca a fonte sem parar (`screenSourceSwap`). */
  canSwapSource?: boolean;
  /** Flags da minha própria sessão (valem mais que o estado do servidor, que chega depois). */
  mine?: { mute: boolean; deaf: boolean; camera: boolean; screen: boolean; cannotSpeak: boolean };
};

const pillIcon = "size-3.5 shrink-0";

function Flags({ tile }: { tile: TileModel }) {
  const { t } = useT();
  const mute = tile.mine ? tile.mine.mute : !!tile.state?.self_mute;
  const deaf = tile.mine ? tile.mine.deaf : !!tile.state?.self_deaf;
  const camera = tile.mine ? tile.mine.camera : !!tile.state?.self_video;
  const screen = tile.mine ? tile.mine.screen : !!tile.state?.self_screen;
  const blocked = !!tile.mine?.cannotSpeak;
  const serverMuted = !!tile.state?.server_muted;
  if (tile.kind === "screen") return null;
  return (
    <span className="flex items-center gap-1 empty:hidden">
      {serverMuted ? (
        <span
          className="inline-flex size-4 items-center justify-center rounded-full bg-destructive text-destructive-foreground"
          title={t("voice.flags.serverMuted")}
        >
          <ShieldOff className="size-2.5" role="img" aria-label={t("voice.flags.serverMuted")} />
        </span>
      ) : null}
      {screen ? (
        <Monitor className={pillIcon} role="img" aria-label={t("voice.flags.sharingScreen")} />
      ) : null}
      {camera ? (
        <Video className={pillIcon} role="img" aria-label={t("voice.flags.cameraOn")} />
      ) : null}
      {deaf ? (
        <span className="inline-flex size-4 items-center justify-center rounded-full bg-destructive text-destructive-foreground">
          <HeadphoneOff className="size-2.5" role="img" aria-label={t("voice.flags.deafened")} />
        </span>
      ) : mute && !serverMuted ? (
        <span
          className="inline-flex size-4 items-center justify-center rounded-full bg-destructive text-destructive-foreground"
          title={blocked ? t("voice.tile.noSpeakTitle") : undefined}
        >
          <MicOff
            className="size-2.5"
            role="img"
            aria-label={blocked ? t("voice.tile.noSpeakShort") : t("voice.flags.muted")}
          />
        </span>
      ) : null}
    </span>
  );
}

/** Um participante (avatar sobre a cor dominante, ou câmera) ou uma tela compartilhada. */
export function ParticipantTile({
  tile,
  width,
  speaking,
  focused = false,
  large = false,
  loading = false,
  interactive = true,
  onFocusTile,
  onFullscreen,
  onWatch,
  onSwapSource,
  channelId = null,
  lookup,
  className,
}: {
  tile: TileModel;
  /** Largura em px (a altura segue o 16:9); sem valor o tile preenche o pai. */
  width?: number;
  speaking: boolean;
  focused?: boolean;
  /** Tile principal do modo foco: avatar maior. */
  large?: boolean;
  /** Conectando: skeleton no lugar do avatar. */
  loading?: boolean;
  /** Prévia (fora da chamada): sem menu nem foco. */
  interactive?: boolean;
  onFocusTile?: (key: string) => void;
  onFullscreen?: (key: string) => void;
  /** Assistir (`true`) ou parar de assistir (`false`) a tela de `userId`. */
  onWatch?: (userId: string, on: boolean) => void;
  onSwapSource?: () => void;
  /** Canal da chamada: de onde vem a miniatura da prévia do tile sem assinatura. */
  channelId?: string | null;
  /** Nomes e avatares de quem assiste a esta tela (a lista só chega ao próprio transmissor). */
  lookup?: PersonLookup;
  className?: string;
}) {
  const { t } = useT();
  const streamerState = useVoiceStatesStore((s) =>
    tile.kind === "screen" ? s.byUser[tile.userId] : undefined,
  );
  const color = useTileColor(tile.avatarUrl, tile.userId);
  const host = useRef<HTMLDivElement>(null);
  const track = tile.video;
  useEffect(() => {
    const el = host.current;
    if (!el || !track) return;
    return track.source.attach(el);
  }, [track]);

  const previewState = useStreamPreview(
    channelId ?? "",
    tile.userId,
    !!tile.unwatched && !!channelId && loadViewStreamPreviews(),
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const [volumeOpen, setVolumeOpen] = useState(false);
  useStageHold(menuOpen || volumeOpen);
  const pipId = usePictureInPictureId();
  const inPip = !!track && pipId === track.id;
  const canPip = !!track && !tile.local && audioCapabilities().pictureInPicture === true;
  const canVolume = interactive && !tile.local && participantVolumeMax() !== null;
  const modState = tile.state && tile.kind === "person" && !tile.local ? tile.state : undefined;
  const moderation = useVoiceModeration(
    modState ?? {
      guild_id: null,
      channel_id: null,
      user_id: "",
      self_mute: false,
      self_deaf: false,
      self_video: false,
      self_screen: false,
      screen_preview: false,
    },
  );
  const canModerateTile = !!modState && moderation.any;

  const isScreenTile = tile.kind === "screen";
  const caption = isScreenTile
    ? tile.local
      ? t("voice.tile.yourScreen")
      : t("voice.stream.screenOf", { name: tile.name })
    : tile.name;
  const avatarPx = Math.max(
    40,
    Math.min(large ? 168 : 128, Math.round((width ?? (large ? 520 : 240)) * 0.3)),
  );
  const isScreen = tile.kind === "screen";

  return (
    <li
      data-testid={track ? "video-tile" : "participant-tile"}
      data-kind={track ? track.kind : tile.unwatched ? "screen" : "person"}
      data-speaking={speaking || undefined}
      data-focused={focused || undefined}
      data-tile-key={tile.key}
      aria-label={caption}
      style={{
        width,
        ...(isScreen
          ? undefined
          : { backgroundImage: `linear-gradient(145deg, ${color.from}, ${color.to})` }),
      }}
      onContextMenu={
        interactive
          ? (e) => {
              e.preventDefault();
              setMenuOpen(true);
            }
          : undefined
      }
      className={cn(
        "group/tile relative isolate list-none overflow-hidden rounded-xl text-white",
        !focused && "aspect-video",
        isScreen && "bg-black",
        className,
      )}
    >
      {tile.unwatched ? (
        <div className="absolute inset-0 z-0 flex items-center justify-center bg-black">
          {previewState.status === "ready" ? (
            <img
              src={previewState.url}
              alt=""
              className="size-full object-contain opacity-60"
              draggable={false}
            />
          ) : previewState.status === "loading" ? (
            <Spinner className="text-white/70" />
          ) : (
            <MonitorUp className="size-10 text-white/40" aria-hidden />
          )}
        </div>
      ) : track ? (
        <div
          ref={host}
          className={cn(
            "pointer-events-none absolute inset-0 z-0 [&_video]:size-full",
            isScreen || focused ? "[&_video]:object-contain" : "[&_video]:object-cover",
          )}
        />
      ) : (
        <div className="absolute inset-0 z-0 flex items-center justify-center">
          {loading ? (
            <Skeleton
              className="rounded-full bg-white/15"
              style={{ width: avatarPx, height: avatarPx }}
            />
          ) : (
            <span className="relative inline-flex rounded-full">
              <Avatar
                url={tile.avatarUrl}
                name={tile.name}
                size={avatarPx}
                fallback="initials"
                seed={tile.userId}
                className="shadow-lg ring-2 ring-white/20"
              />
              {speaking ? (
                <span
                  aria-hidden
                  className="pointer-events-none absolute -inset-1.5 animate-speaking rounded-full border-[3px] border-speaking"
                />
              ) : null}
            </span>
          )}
        </div>
      )}
      {/* escurecimento para o texto do rodapé do tile */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 z-[1] h-1/2 bg-gradient-to-t from-black/60 to-transparent"
      />
      {/* anel de quem fala (estático no tile; o pulso fica no avatar) */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 z-[2] rounded-[inherit] ring-inset transition-shadow duration-[var(--dur-base)]",
          speaking ? "ring-[3px] ring-speaking" : "ring-1 ring-white/10",
        )}
      />
      {tile.unwatched && interactive ? (
        <div className="absolute inset-0 z-[3] flex items-center justify-center">
          <Button
            type="button"
            size="lg"
            className="cursor-pointer rounded-full shadow-lg"
            aria-label={t("voice.tile.watchLabel", { name: tile.name })}
            data-focus-target
            onClick={() => onWatch?.(tile.userId, true)}
          >
            <Monitor /> {t("voice.tile.watch")}
          </Button>
        </div>
      ) : null}
      {interactive && track ? (
        <button
          type="button"
          onClick={() => onFocusTile?.(tile.key)}
          aria-label={
            focused
              ? t(isScreenTile ? "voice.tile.backScreen" : "voice.tile.backCamera", {
                  name: tile.name,
                })
              : t(isScreenTile ? "voice.tile.highlightScreen" : "voice.tile.highlightCamera", {
                  name: tile.name,
                })
          }
          aria-pressed={focused}
          data-focus-target
          className="absolute inset-0 z-[3] cursor-pointer rounded-[inherit] outline-none focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:ring-inset"
        />
      ) : null}
      <div className="pointer-events-none absolute right-2 bottom-2 left-2 z-[4] flex items-center">
        <div
          className="flex max-w-full min-w-0 items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-xs font-medium backdrop-blur-sm"
          data-testid="tile-label"
        >
          <Flags tile={tile} />
          <span className="truncate">{caption}</span>
          {speaking ? <span className="sr-only">{t("voice.speaking")}</span> : null}
          {isScreen ? (
            <ViewersBadge
              state={streamerState}
              lookup={lookup}
              tone="onVideo"
              className="shrink-0"
            />
          ) : null}
        </div>
      </div>
      {interactive ? (
        <div
          className={cn(
            "absolute top-2 right-2 z-[5] flex gap-1 opacity-0 transition-opacity duration-[var(--dur-fast)] group-focus-within/tile:opacity-100 group-hover/tile:opacity-100 [@media(hover:none)]:opacity-100",
            menuOpen && "opacity-100",
          )}
        >
          {tile.canStopWatching && track ? (
            <Button
              variant="secondary"
              size="icon"
              className="size-8 rounded-full bg-black/60 text-white backdrop-blur-sm hover:bg-black/75 hover:text-white"
              aria-label={t("voice.tile.stopLabel", { name: tile.name })}
              onClick={() => onWatch?.(tile.userId, false)}
            >
              <EyeOff />
            </Button>
          ) : null}
          {track ? (
            <Button
              variant="secondary"
              size="icon"
              className="size-8 rounded-full bg-black/60 text-white backdrop-blur-sm hover:bg-black/75 hover:text-white"
              aria-label={t(
                isScreenTile ? "voice.tile.fullscreenScreen" : "voice.tile.fullscreenCamera",
                { name: tile.name },
              )}
              onClick={() => onFullscreen?.(tile.key)}
            >
              <Expand />
            </Button>
          ) : null}
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="secondary"
                size="icon"
                className="size-8 rounded-full bg-black/60 text-white backdrop-blur-sm hover:bg-black/75 hover:text-white"
                aria-label={t("voice.tile.options", { caption })}
              >
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {track ? (
                <DropdownMenuItem onSelect={() => onFocusTile?.(tile.key)}>
                  {focused ? <Minimize2 /> : <Maximize2 />}
                  {focused ? t("voice.tile.backToGrid") : t("voice.tile.highlight")}
                </DropdownMenuItem>
              ) : null}
              {tile.unwatched ? (
                <DropdownMenuItem onSelect={() => onWatch?.(tile.userId, true)}>
                  <Monitor /> {t("voice.tile.watch")}
                </DropdownMenuItem>
              ) : null}
              {tile.canStopWatching && track ? (
                <DropdownMenuItem onSelect={() => onWatch?.(tile.userId, false)}>
                  <EyeOff /> {t("voice.tile.stopWatching")}
                </DropdownMenuItem>
              ) : null}
              {tile.canSwapSource && tile.local && tile.kind === "screen" ? (
                <DropdownMenuItem onSelect={() => onSwapSource?.()}>
                  <RefreshCw /> {t("voice.tile.swap")}
                </DropdownMenuItem>
              ) : null}
              {canVolume ? (
                <DropdownMenuItem onSelect={() => setVolumeOpen(true)}>
                  <Volume2 /> {t("voice.tile.volumeOf", { name: tile.name })}
                </DropdownMenuItem>
              ) : null}
              {canPip && track ? (
                <DropdownMenuCheckboxItem
                  checked={inPip}
                  onSelect={() =>
                    void togglePictureInPicture(track).catch(() =>
                      toast.error(t("voice.tile.pipError")),
                    )
                  }
                >
                  <PictureInPicture2 /> {t("voice.tile.pip")}
                </DropdownMenuCheckboxItem>
              ) : null}
              {track ? (
                <DropdownMenuItem onSelect={() => onFullscreen?.(tile.key)}>
                  <Expand /> {t("voice.tile.fullscreen")}
                </DropdownMenuItem>
              ) : null}
              {canModerateTile && modState ? (
                <VoiceModerationItems state={modState} name={tile.name} />
              ) : null}
              {!track && !canVolume && !tile.unwatched && !canModerateTile ? (
                <DropdownMenuItem disabled>{t("voice.tile.noActions")}</DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : null}
      {volumeOpen && canVolume ? (
        <PersonVolumePanel
          userId={tile.userId}
          name={tile.name}
          onClose={() => setVolumeOpen(false)}
          className="absolute top-12 right-2 z-[6] w-64 max-w-[calc(100%-1rem)] text-sm"
        />
      ) : null}
    </li>
  );
}
