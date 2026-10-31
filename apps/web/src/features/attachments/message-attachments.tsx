import type { AttachmentPayload } from "@spook/shared";
import { Download, FileArchive, File as FileIcon, FileText, ImageOff } from "lucide-react";
import { useRef, useState } from "react";
import { formatBytes } from "@/lib/file-size";
import { Lightbox } from "./lightbox";
import { fitSize, imagesOf, isAudio, isImage, isVideo } from "./media";

/** Anexos de uma mensagem: imagens (miniatura + visualizador), áudio/vídeo (player nativo) e cartões de arquivo. */
export function MessageAttachments({ attachments }: { attachments: readonly AttachmentPayload[] }) {
  const [open, setOpen] = useState<number | null>(null);
  // Quem abriu o visualizador: o foco volta para lá ao fechar.
  const opener = useRef<HTMLElement | null>(null);
  if (attachments.length === 0) return null;
  const images = imagesOf(attachments);
  return (
    <div className="mt-1 flex flex-col items-start gap-2">
      {images.length > 0 ? (
        <ul aria-label="Imagens" className="flex flex-wrap gap-2">
          {images.map((a, i) => (
            <li key={a.id}>
              <ImageThumb
                attachment={a}
                onOpen={(trigger) => {
                  opener.current = trigger;
                  setOpen(i);
                }}
              />
            </li>
          ))}
        </ul>
      ) : null}
      {attachments
        .filter((a) => !isImage(a))
        .map((a) =>
          isAudio(a) ? (
            <AudioPlayer key={a.id} attachment={a} />
          ) : isVideo(a) ? (
            <VideoPlayer key={a.id} attachment={a} />
          ) : (
            <FileCard key={a.id} attachment={a} />
          ),
        )}
      <Lightbox
        images={images}
        index={open}
        onIndexChange={setOpen}
        onClose={() => setOpen(null)}
        returnFocusTo={opener}
      />
    </div>
  );
}

/**
 * Miniatura clicável. Enquanto o job de thumbnail não termina (sem `thumbnail_url`) mostra o
 * original; com `width`/`height` a proporção é reservada, para a lista não pular quando a imagem
 * carrega ou quando o `MESSAGE_UPDATE` troca o original pela miniatura.
 */
export function ImageThumb({
  attachment: a,
  onOpen,
}: {
  attachment: AttachmentPayload;
  onOpen: (trigger: HTMLElement) => void;
}) {
  // A miniatura pode falhar (link vencido ou arquivo removido): cai para o original; se esse também falhar, mostra o aviso.
  const [broken, setBroken] = useState<string[]>([]);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const src = [a.thumbnail_url, a.url].find((u): u is string => !!u && !broken.includes(u));
  const dims = a.width && a.height ? { w: a.width, h: a.height } : natural ? natural : null;
  const box = dims ? fitSize(dims.w, dims.h) : { width: 256, height: 192 };

  if (!src)
    return (
      <div className="flex items-center gap-2 rounded-md border p-3 text-xs text-muted-foreground">
        <ImageOff className="size-4" aria-hidden /> Não foi possível carregar {a.filename}
      </div>
    );
  return (
    <button
      type="button"
      onClick={(e) => onOpen(e.currentTarget)}
      aria-label={`Abrir imagem ${a.filename}`}
      className="block overflow-hidden rounded-md border bg-muted focus-visible:outline-2 focus-visible:outline-ring"
      style={{
        width: box.width,
        maxWidth: "100%",
        aspectRatio: `${box.width} / ${box.height}`,
      }}
    >
      <img
        src={src}
        alt={a.filename}
        loading="lazy"
        decoding="async"
        // object-fit (e não rotação): o thumbnail do servidor ignora a orientação EXIF.
        className="size-full object-contain"
        onLoad={(e) => {
          const img = e.currentTarget;
          if (!(a.width && a.height) && img.naturalWidth > 0)
            setNatural({ w: img.naturalWidth, h: img.naturalHeight });
        }}
        onError={() => setBroken((b) => [...b, src])}
      />
    </button>
  );
}

function AudioPlayer({ attachment: a }: { attachment: AttachmentPayload }) {
  return (
    <figure className="flex max-w-full flex-col gap-1">
      <figcaption className="text-xs text-muted-foreground">
        {a.filename} · {formatBytes(a.size)}
      </figcaption>
      {/* biome-ignore lint/a11y/useMediaCaption: anexos do usuário não têm legendas */}
      <audio
        controls
        preload="none"
        src={a.url}
        aria-label={a.filename}
        className="w-72 max-w-full"
      />
    </figure>
  );
}

function VideoPlayer({ attachment: a }: { attachment: AttachmentPayload }) {
  return (
    <figure className="flex max-w-full flex-col gap-1">
      <figcaption className="text-xs text-muted-foreground">
        {a.filename} · {formatBytes(a.size)}
      </figcaption>
      {/* biome-ignore lint/a11y/useMediaCaption: anexos do usuário não têm legendas */}
      <video
        controls
        preload="metadata"
        src={a.url}
        aria-label={a.filename}
        className="max-h-72 max-w-full rounded-md border bg-black sm:max-w-sm"
      />
    </figure>
  );
}

function iconFor(contentType: string) {
  if (contentType === "application/zip") return FileArchive;
  if (contentType === "application/pdf" || contentType.startsWith("text/")) return FileText;
  return FileIcon;
}

/** Cartão de arquivo: ícone, nome, tamanho e baixar. */
export function FileCard({ attachment: a }: { attachment: AttachmentPayload }) {
  const Icon = iconFor(a.content_type);
  return (
    <div className="flex w-72 max-w-full items-center gap-3 rounded-md border bg-secondary/40 p-3">
      <Icon className="size-8 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium" title={a.filename}>
          {a.filename}
        </p>
        <p className="text-xs text-muted-foreground">{formatBytes(a.size)}</p>
      </div>
      <a
        href={a.url}
        download={a.filename}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Baixar ${a.filename}`}
        className="rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      >
        <Download className="size-4" />
      </a>
    </div>
  );
}
