import { Hash } from "lucide-react";
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Tópico do canal no cabeçalho: uma linha truncada (com dica ao passar o mouse); clicar (ou Enter) abre o texto
 * inteiro num diálogo, que é como se lê o tópico em telas pequenas (390 px) e quando ele é longo.
 */
export function ChannelTopic({ name, topic }: { name: string; topic: string | null | undefined }) {
  const [open, setOpen] = useState(false);
  if (!topic) return null;
  const oneLine = topic.replace(/\s+/g, " ");
  return (
    <>
      <span aria-hidden className="hidden h-5 w-px shrink-0 bg-border sm:block" />
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-haspopup="dialog"
            aria-label={`Tópico do canal: ${oneLine}`}
            data-testid="channel-topic"
            onClick={() => setOpen(true)}
            className="min-h-9 min-w-0 flex-1 truncate rounded-md px-2 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            {oneLine}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs">
          {oneLine.length > 160 ? `${oneLine.slice(0, 160)}…` : oneLine} (clique para ler tudo)
        </TooltipContent>
      </Tooltip>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-1.5">
              <Hash className="size-5 text-muted-foreground" aria-hidden />
              {name}
            </DialogTitle>
            <DialogDescription>Tópico do canal</DialogDescription>
          </DialogHeader>
          <p className="max-h-[60vh] overflow-y-auto text-sm leading-6 break-words whitespace-pre-wrap">
            {topic}
          </p>
        </DialogContent>
      </Dialog>
    </>
  );
}
