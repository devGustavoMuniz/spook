import { Maximize2, PictureInPicture2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { audioCapabilities } from "./controller";
import type { VideoTrackInfo } from "./engine";
import { PersonVolumeButton, PersonVolumePanel } from "./person-volume";
import { togglePictureInPicture, usePictureInPictureId } from "./pip";
import { useVoiceStore } from "./store";
import type { PersonLookup } from "./use-person-lookup";

/** Monta a fonte de vídeo num host; quem desenha (`<video>`, canvas…) é a engine. */
function VideoTile({
  track,
  label,
  featured,
  onFocus,
}: {
  track: VideoTrackInfo;
  label: string;
  featured: boolean;
  onFocus: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    return track.source.attach(el);
  }, [track.source]);

  const what = track.kind === "screen" ? "Tela" : "Câmera";
  const [volumeOpen, setVolumeOpen] = useState(false);
  const pipId = usePictureInPictureId();
  const inPip = pipId === track.id;
  // Janela flutuante: só para vídeo de outra pessoa, onde o navegador suporta e a engine desenha com <video>.
  const canPip = !track.local && audioCapabilities().pictureInPicture === true;
  return (
    <figure
      data-testid="video-tile"
      data-kind={track.kind}
      className={cn(
        "group relative overflow-hidden rounded-lg bg-black",
        featured ? "min-h-0 flex-1" : "aspect-video w-48 shrink-0",
      )}
    >
      <button
        type="button"
        onClick={onFocus}
        aria-label={`Destacar ${what.toLowerCase()} de ${label}`}
        className="absolute inset-0 z-0"
      />
      <div ref={host} className="pointer-events-none absolute inset-0" />
      <figcaption className="absolute bottom-1 left-1 z-10 max-w-[90%] truncate rounded bg-black/60 px-2 py-0.5 text-xs text-white">
        {track.local ? "Você" : label} · {what}
      </figcaption>
      <div className="absolute top-1 right-1 z-10 flex gap-1 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
        {featured && !track.local ? (
          <PersonVolumeButton
            userId={track.identity}
            name={label}
            open={volumeOpen}
            onToggle={() => setVolumeOpen((o) => !o)}
            className="size-7 bg-secondary text-secondary-foreground"
          />
        ) : null}
        {canPip ? (
          <Button
            variant="secondary"
            size="icon"
            className="size-7"
            aria-label={`Janela flutuante: ${what.toLowerCase()} de ${label}`}
            aria-pressed={inPip}
            title={inPip ? "Fechar a janela flutuante" : "Abrir em janela flutuante"}
            onClick={() =>
              void togglePictureInPicture(track).catch(() =>
                toast.error("Não foi possível abrir a janela flutuante."),
              )
            }
          >
            <PictureInPicture2 />
          </Button>
        ) : null}
        <Button
          variant="secondary"
          size="icon"
          className="size-7"
          aria-label={`Tela cheia: ${what.toLowerCase()} de ${label}`}
          onClick={() => void host.current?.parentElement?.requestFullscreen?.()}
        >
          <Maximize2 />
        </Button>
      </div>
      {featured && volumeOpen && !track.local ? (
        <PersonVolumePanel
          userId={track.identity}
          name={label}
          onClose={() => setVolumeOpen(false)}
          className="absolute top-10 right-1 z-20 w-64"
        />
      ) : null}
    </figure>
  );
}

/** Ordem de destaque: a tela compartilhada primeiro (a mais antiga), depois câmeras. */
export function orderTracks(tracks: VideoTrackInfo[], focusedId: string | null) {
  const featured =
    tracks.find((t) => t.id === focusedId) ?? tracks.find((t) => t.kind === "screen") ?? tracks[0];
  return { featured, others: tracks.filter((t) => t !== featured) };
}

/**
 * Painel de vídeo: uma peça em destaque (tela compartilhada por padrão; clique em outra para trocar)
 * e as demais numa faixa. Sem nenhum vídeo, não ocupa espaço.
 */
export function VideoGrid({ lookup }: { lookup: PersonLookup }) {
  const tracks = useVoiceStore((s) => s.videoTracks);
  const [focused, setFocused] = useState<string | null>(null);
  if (tracks.length === 0) return null;
  const { featured, others } = orderTracks(tracks, focused);
  if (!featured) return null;
  return (
    <section aria-label="Vídeo da chamada" className="flex min-h-0 flex-1 flex-col gap-2 p-3">
      <VideoTile
        key={featured.id}
        track={featured}
        label={lookup(featured.identity).name}
        featured
        onFocus={() => setFocused(featured.id)}
      />
      {others.length > 0 ? (
        <div className="flex gap-2 overflow-x-auto">
          {others.map((t) => (
            <VideoTile
              key={t.id}
              track={t}
              label={lookup(t.identity).name}
              featured={false}
              onFocus={() => setFocused(t.id)}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}
