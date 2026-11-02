import type { VoiceStatePayload } from "@spook/shared";
import {
  Expand,
  HeadphoneOff,
  Maximize2,
  MicOff,
  Minimize2,
  Monitor,
  MoreHorizontal,
  PictureInPicture2,
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
import { cn } from "@/lib/utils";
import { audioCapabilities, participantVolumeMax } from "../controller";
import type { VideoTrackInfo } from "../engine";
import { PersonVolumePanel } from "../person-volume";
import { togglePictureInPicture, usePictureInPictureId } from "../pip";
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
  /** Flags da minha própria sessão (valem mais que o estado do servidor, que chega depois). */
  mine?: { mute: boolean; deaf: boolean; camera: boolean; screen: boolean; cannotSpeak: boolean };
};

const pillIcon = "size-3.5 shrink-0";

function Flags({ tile }: { tile: TileModel }) {
  const mute = tile.mine ? tile.mine.mute : !!tile.state?.self_mute;
  const deaf = tile.mine ? tile.mine.deaf : !!tile.state?.self_deaf;
  const camera = tile.mine ? tile.mine.camera : !!tile.state?.self_video;
  const screen = tile.mine ? tile.mine.screen : !!tile.state?.self_screen;
  const blocked = !!tile.mine?.cannotSpeak;
  if (tile.kind === "screen") return null;
  return (
    <span className="flex items-center gap-1 empty:hidden">
      {screen ? (
        <Monitor className={pillIcon} role="img" aria-label="Compartilhando a tela" />
      ) : null}
      {camera ? <Video className={pillIcon} role="img" aria-label="Câmera ligada" /> : null}
      {deaf ? (
        <span className="inline-flex size-4 items-center justify-center rounded-full bg-destructive text-destructive-foreground">
          <HeadphoneOff className="size-2.5" role="img" aria-label="Áudio desativado" />
        </span>
      ) : mute ? (
        <span
          className="inline-flex size-4 items-center justify-center rounded-full bg-destructive text-destructive-foreground"
          title={blocked ? "Sem permissão para falar neste canal" : undefined}
        >
          <MicOff
            className="size-2.5"
            role="img"
            aria-label={blocked ? "Sem permissão para falar" : "Microfone silenciado"}
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
  className?: string;
}) {
  const color = useTileColor(tile.avatarUrl, tile.userId);
  const host = useRef<HTMLDivElement>(null);
  const track = tile.video;
  useEffect(() => {
    const el = host.current;
    if (!el || !track) return;
    return track.source.attach(el);
  }, [track]);

  const [menuOpen, setMenuOpen] = useState(false);
  const [volumeOpen, setVolumeOpen] = useState(false);
  useStageHold(menuOpen || volumeOpen);
  const pipId = usePictureInPictureId();
  const inPip = !!track && pipId === track.id;
  const canPip = !!track && !tile.local && audioCapabilities().pictureInPicture === true;
  const canVolume = interactive && !tile.local && participantVolumeMax() !== null;

  const what = tile.kind === "screen" ? "Tela" : "Câmera";
  const caption =
    tile.kind === "screen" ? (tile.local ? "Sua tela" : `Tela de ${tile.name}`) : tile.name;
  const avatarPx = Math.max(
    40,
    Math.min(large ? 168 : 128, Math.round((width ?? (large ? 520 : 240)) * 0.3)),
  );
  const isScreen = tile.kind === "screen";

  return (
    <li
      data-testid={track ? "video-tile" : "participant-tile"}
      data-kind={track ? track.kind : "person"}
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
      {track ? (
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
      {interactive && track ? (
        <button
          type="button"
          onClick={() => onFocusTile?.(tile.key)}
          aria-label={
            focused
              ? `Voltar à grade: ${what.toLowerCase()} de ${tile.name}`
              : `Destacar ${what.toLowerCase()} de ${tile.name}`
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
          {speaking ? <span className="sr-only"> (falando)</span> : null}
        </div>
      </div>
      {interactive ? (
        <div
          className={cn(
            "absolute top-2 right-2 z-[5] flex gap-1 opacity-0 transition-opacity duration-[var(--dur-fast)] group-focus-within/tile:opacity-100 group-hover/tile:opacity-100 [@media(hover:none)]:opacity-100",
            menuOpen && "opacity-100",
          )}
        >
          {track ? (
            <Button
              variant="secondary"
              size="icon"
              className="size-8 rounded-full bg-black/60 text-white backdrop-blur-sm hover:bg-black/75 hover:text-white"
              aria-label={`Tela cheia: ${what.toLowerCase()} de ${tile.name}`}
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
                aria-label={`Opções de ${caption}`}
              >
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {track ? (
                <DropdownMenuItem onSelect={() => onFocusTile?.(tile.key)}>
                  {focused ? <Minimize2 /> : <Maximize2 />}
                  {focused ? "Voltar à grade" : "Destacar"}
                </DropdownMenuItem>
              ) : null}
              {canVolume ? (
                <DropdownMenuItem onSelect={() => setVolumeOpen(true)}>
                  <Volume2 /> Volume de {tile.name}
                </DropdownMenuItem>
              ) : null}
              {canPip && track ? (
                <DropdownMenuCheckboxItem
                  checked={inPip}
                  onSelect={() =>
                    void togglePictureInPicture(track).catch(() =>
                      toast.error("Não foi possível abrir a janela flutuante."),
                    )
                  }
                >
                  <PictureInPicture2 /> Janela flutuante
                </DropdownMenuCheckboxItem>
              ) : null}
              {track ? (
                <DropdownMenuItem onSelect={() => onFullscreen?.(tile.key)}>
                  <Expand /> Tela cheia
                </DropdownMenuItem>
              ) : null}
              {!track && !canVolume ? (
                <DropdownMenuItem disabled>Nenhuma ação disponível</DropdownMenuItem>
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
