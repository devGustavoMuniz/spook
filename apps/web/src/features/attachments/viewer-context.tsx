import type { AttachmentPayload, MessagePayload } from "@spook/shared";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { Lightbox } from "./lightbox";
import { imagesOf } from "./media";

type Viewer = { open: (attachmentId: string, trigger: HTMLElement) => void };
const ViewerContext = createContext<Viewer | null>(null);

/** Quem renderiza anexos fora de uma conversa (ou em teste isolado) não tem visualizador compartilhado. */
export const useImageViewer = () => useContext(ViewerContext);

/**
 * Visualizador de imagens da conversa inteira: setas navegam entre as imagens de todas as mensagens
 * carregadas (da mais antiga para a mais nova), não só as da mensagem clicada.
 */
export function ImageViewerProvider({
  messages,
  children,
}: {
  messages: readonly MessagePayload[];
  children: ReactNode;
}) {
  const images = useMemo<AttachmentPayload[]>(
    () => messages.flatMap((m) => imagesOf(m.attachments ?? [])),
    [messages],
  );
  const [index, setIndex] = useState<number | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const open = useCallback(
    (id: string, trigger: HTMLElement) => {
      const i = images.findIndex((a) => a.id === id);
      if (i < 0) return;
      opener.current = trigger;
      setIndex(i);
    },
    [images],
  );
  const value = useMemo(() => ({ open }), [open]);
  return (
    <ViewerContext.Provider value={value}>
      {children}
      <Lightbox
        images={images}
        index={index}
        onIndexChange={setIndex}
        onClose={() => setIndex(null)}
        returnFocusTo={opener}
      />
    </ViewerContext.Provider>
  );
}
