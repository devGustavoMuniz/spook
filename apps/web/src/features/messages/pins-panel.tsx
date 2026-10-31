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
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Mensagens fixadas"
        title="Mensagens fixadas"
        onClick={() => setOpen(true)}
      >
        <Pin />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Mensagens fixadas</DialogTitle>
            <DialogDescription>As mais recentes primeiro (até 50 por canal).</DialogDescription>
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
  // Montada só com o diálogo aberto: busca de novo a cada abertura (e o gateway a mantém em dia enquanto aberta).
  const pins = useListPinnedMessages(channelId, { query: { refetchOnMount: "always" } });
  const pin = usePinToggle(channelId);
  const jumpTo = useJumpStore((s) => s.jumpTo);

  if (pins.isPending) {
    return <output className="text-sm text-muted-foreground">Carregando fixadas…</output>;
  }
  if (pins.isError) {
    return (
      <div className="text-sm">
        <p className="text-destructive-text">{appMessage(pins.error)}</p>
        <button type="button" className="mt-2 underline" onClick={() => void pins.refetch()}>
          Tentar de novo
        </button>
      </div>
    );
  }
  const messages = pins.data.messages ?? [];
  if (messages.length === 0) {
    return <p className="text-sm text-muted-foreground">Nenhuma mensagem fixada neste canal.</p>;
  }
  return (
    <ul aria-label="Mensagens fixadas" className="flex flex-col gap-2">
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
  const name = m.author.display_name || m.author.username;
  const files = (m.attachments ?? []).length;
  return (
    <li className="flex flex-col gap-1.5 rounded-md border p-3">
      <div className="flex items-center gap-2 text-sm">
        <Avatar url={m.author.avatar_url} name={name} size={24} />
        <span className="font-medium">{name}</span>
        <time dateTime={m.created_at} className="text-xs text-muted-foreground">
          {formatMessageTime(m.created_at)}
        </time>
      </div>
      {m.content ? (
        <p className="line-clamp-4 text-sm break-words whitespace-pre-wrap">{m.content}</p>
      ) : null}
      {files > 0 ? (
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          <Paperclip className="size-3" aria-hidden />
          {files === 1 ? "1 anexo" : `${files} anexos`}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={onGo}
          aria-label={`Ir para a mensagem de ${name}`}
        >
          Ir para a mensagem
        </Button>
        {canUnpin ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={onUnpin}
            aria-label={`Desafixar a mensagem de ${name}`}
          >
            Desafixar
          </Button>
        ) : null}
      </div>
    </li>
  );
}
