import type { AttachmentPayload } from "@spook/shared";
import {
  Download,
  FileArchive,
  FileAudio,
  FileCode,
  File as FileIcon,
  FileText,
  FileVideo,
  ImageOff,
} from "lucide-react";
import { useRef, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { useT } from "@/i18n";
import { formatBytes } from "@/lib/file-size";
import { Lightbox } from "./lightbox";
import { fitSize, imagesOf, isAudio, isImage, isVideo } from "./media";
import { useImageViewer } from "./viewer-context";

/** Anexos de uma mensagem: imagens (miniatura + visualizador), áudio/vídeo (player nativo) e cartões de arquivo. */
export function MessageAttachments({ attachments }: { attachments: readonly AttachmentPayload[] }) {
  const { t } = useT();
  const shared = useImageViewer();
  const [open, setOpen] = useState<number | null>(null);
  // Quem abriu o visualizador: o foco volta para lá ao fechar.
  const opener = useRef<HTMLElement | null>(null);
  if (attachments.length === 0) return null;
  const images = imagesOf(attachments);
  return (
    <div className="mt-1.5 flex max-w-full flex-col items-start gap-2">
      {images.length > 0 ? (
        <ul aria-label={t("chat.attach.images")} className="flex max-w-full flex-wrap gap-2">
          {images.map((a, i) => (
            <li key={a.id} className="max-w-full">
              <ImageThumb
                attachment={a}
                onOpen={(trigger) => {
                  // Na conversa o visualizador é um só (setas passam por todas as imagens carregadas).
                  if (shared) return shared.open(a.id, trigger);
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
      {shared ? null : (
        <Lightbox
          images={images}
          index={open}
          onIndexChange={setOpen}
          onClose={() => setOpen(null)}
          returnFocusTo={opener}
        />
      )}
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
  const { t } = useT();
  // A miniatura pode falhar (link vencido ou arquivo removido): cai para o original; se esse também falhar, mostra o aviso.
  const [broken, setBroken] = useState<string[]>([]);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const src = [a.thumbnail_url, a.url].find((u): u is string => !!u && !broken.includes(u));
  const dims = a.width && a.height ? { w: a.width, h: a.height } : natural ? natural : null;
  const box = dims ? fitSize(dims.w, dims.h) : { width: 256, height: 192 };

  if (!src)
    return (
      <div className="flex items-center gap-2 rounded-xl border bg-surface-1 p-3 text-xs text-muted-foreground">
        <ImageOff className="size-4" aria-hidden />{" "}
        {t("chat.attach.loadFailed", { name: a.filename })}
      </div>
    );
  return (
    <button
      type="button"
      onClick={(e) => onOpen(e.currentTarget)}
      aria-label={t("chat.attach.openImage", { name: a.filename })}
      className="group/img relative block overflow-hidden rounded-xl border border-border bg-muted shadow-xs transition-shadow hover:shadow-md"
      style={{
        width: box.width,
        maxWidth: "100%",
        aspectRatio: `${box.width} / ${box.height}`,
      }}
    >
      {loaded ? null : <Skeleton className="absolute inset-0 rounded-none" />}
      <img
        src={src}
        alt={a.filename}
        loading="lazy"
        decoding="async"
        ref={(el) => {
          // Imagem já em cache: o load pode ter acontecido antes de o React ligar o onLoad.
          if (el?.complete && el.naturalWidth > 0) setLoaded(true);
        }}
        // object-fit (e não rotação): o thumbnail do servidor ignora a orientação EXIF.
        className={`size-full object-contain transition-[opacity,transform] duration-[var(--dur-slow)] group-hover/img:scale-[1.02] ${loaded ? "opacity-100" : "opacity-0"}`}
        onLoad={(e) => {
          setLoaded(true);
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
        className="max-h-72 max-w-full rounded-xl border border-border bg-surface-3 sm:max-w-sm"
      />
    </figure>
  );
}

function iconFor(a: Pick<AttachmentPayload, "content_type" | "filename">) {
  const t = a.content_type;
  if (t === "application/zip") return FileArchive;
  if (t.startsWith("audio/")) return FileAudio;
  if (t.startsWith("video/")) return FileVideo;
  if (/\.(json|js|ts|tsx|go|py|css|html|sh|sql|yaml|yml)$/i.test(a.filename)) return FileCode;
  if (t === "application/pdf" || t.startsWith("text/")) return FileText;
  return FileIcon;
}

function extensionOf(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i > 0 && i < filename.length - 1 ? filename.slice(i + 1, i + 6).toUpperCase() : "";
}

/** Cartão de arquivo: ícone por tipo, nome, tipo/tamanho e baixar. */
export function FileCard({ attachment: a }: { attachment: AttachmentPayload }) {
  const { t } = useT();
  const Icon = iconFor(a);
  const ext = extensionOf(a.filename);
  return (
    <div className="flex w-80 max-w-full items-center gap-3 rounded-xl border border-border bg-card p-3 shadow-xs transition-colors hover:bg-surface-2">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-accent text-brand-text">
        <Icon className="size-5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium" title={a.filename}>
          {a.filename}
        </p>
        <p className="tabular text-xs text-muted-foreground">
          {ext ? `${ext} · ` : ""}
          {formatBytes(a.size)}
        </p>
      </div>
      <a
        href={a.url}
        download={a.filename}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={t("chat.attach.download", { name: a.filename })}
        className="rounded-lg p-2 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      >
        <Download className="size-4" />
      </a>
    </div>
  );
}
