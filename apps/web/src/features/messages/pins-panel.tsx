import { type MessagePayload, useListPinnedMessages } from "@spook/shared";
import { Paperclip, Pin } from "lucide-react";
import { useState } from "react";
import { Avatar } from "@/components/avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useT } from "@/i18n";
import { appMessage } from "@/lib/app-errors";
import { formatMessageTime } from "@/lib/format";
import { useJumpStore } from "./jump";
import { usePinToggle } from "./use-pin";

/**
 * Botão "Mensagens fixadas" do cabeçalho do canal/DM. Abre um diálogo com a lista (GET /pins, mantida
 * em dia pelos MESSAGE_UPDATE do gateway) e leva até a mensagem no histórico.
 */
export function PinnedMessagesButton({
  channelId,
  canUnpin,
}: {
  channelId: string;
  /** MANAGE_MESSAGES no servidor; qualquer participante em DM. */
  canUnpin: boolean;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        aria-label={t("chat.pins.title")}
        title={t("chat.pins.title")}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <Pin />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>{t("chat.pins.title")}</DialogTitle>
            <DialogDescription>{t("chat.pins.description")}</DialogDescription>
          </DialogHeader>
          <PinsList channelId={channelId} canUnpin={canUnpin} onClose={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}

function PinsList({
  channelId,
  canUnpin,
  onClose,
}: {
  channelId: string;
  canUnpin: boolean;
  onClose: () => void;
}) {
  const { t } = useT();
  // Montada só com o diálogo aberto: busca de novo a cada abertura (e o gateway a mantém em dia enquanto aberta).
  const pins = useListPinnedMessages(channelId, { query: { refetchOnMount: "always" } });
  const pin = usePinToggle(channelId);
  const jumpTo = useJumpStore((s) => s.jumpTo);

  if (pins.isPending) {
    return (
      <output className="flex flex-col gap-2">
        <span className="sr-only">{t("chat.pins.loading")}</span>
        <Skeleton className="h-20 rounded-xl" />
        <Skeleton className="h-20 rounded-xl" />
      </output>
    );
  }
  if (pins.isError) {
    return (
      <div className="flex flex-col items-start gap-2 text-sm">
        <p className="text-destructive-text">{appMessage(pins.error)}</p>
        <Button variant="secondary" size="sm" onClick={() => void pins.refetch()}>
          {t("chat.pins.retry")}
        </Button>
      </div>
    );
  }
  const messages = pins.data.messages ?? [];
  if (messages.length === 0) {
    return (
      <EmptyState
        className="py-8"
        illustration={
          <span className="flex size-14 items-center justify-center rounded-2xl bg-accent text-brand-text">
            <Pin className="size-7" aria-hidden />
          </span>
        }
        title={t("chat.pins.emptyTitle")}
        description={t("chat.pins.emptyDescription")}
      />
    );
  }
  return (
    <ul
      aria-label={t("chat.pins.title")}
      className="flex max-h-[60svh] flex-col gap-2 overflow-y-auto"
    >
      {messages.map((m) => (
        <PinItem
          key={m.id}
          message={m}
          canUnpin={canUnpin}
          busy={pin.pending}
          onGo={() => {
            onClose();
            jumpTo(channelId, m.id);
          }}
          onUnpin={() => void pin.toggle(m)}
        />
      ))}
    </ul>
  );
}

function PinItem({
  message: m,
  canUnpin,
  busy,
  onGo,
  onUnpin,
}: {
  message: MessagePayload;
  canUnpin: boolean;
  busy: boolean;
  onGo: () => void;
  onUnpin: () => void;
}) {
  const { t } = useT();
  const name = m.author.display_name || m.author.username;
  const files = (m.attachments ?? []).length;
  return (
    <li className="flex flex-col gap-2 rounded-xl border border-border bg-surface-1 p-3">
      <div className="flex items-center gap-2 text-sm">
        <Avatar url={m.author.avatar_url} name={name} seed={m.author.id} size={24} />
        <span className="font-semibold">{name}</span>
        <time dateTime={m.created_at} className="text-xs tabular text-muted-foreground">
          {formatMessageTime(m.created_at)}
        </time>
      </div>
      {m.content ? (
        <p className="line-clamp-4 text-sm break-words whitespace-pre-wrap">{m.content}</p>
      ) : null}
      {files > 0 ? (
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          <Paperclip className="size-3" aria-hidden />
          {t("chat.pins.attachments", { count: files })}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={onGo}
          aria-label={t("chat.pins.goToAria", { name })}
        >
          {t("chat.pins.goTo")}
        </Button>
        {canUnpin ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={onUnpin}
            aria-label={t("chat.pins.unpinAria", { name })}
          >
            {t("chat.pins.unpin")}
          </Button>
        ) : null}
      </div>
    </li>
  );
}
